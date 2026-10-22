import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { schema, type MovementReason } from '@pos/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Db } from '../core/database';
import { currentContext, currentTenant } from '../core/request-context';

export interface MovementLine {
  locationId: string;
  variantId: string;
  quantityDelta: number;
  reason: MovementReason;
}

export interface OperationInput {
  kind: 'receipt' | 'adjustment' | 'transfer' | 'count';
  idempotencyKey?: string;
  note?: string | null;
  reference?: { type: string; id: string };
  lines: MovementLine[];
}

export interface OperationResult {
  operationId: string;
  /** True when the idempotency key matched an earlier request; nothing new was written. */
  replayed: boolean;
  movements: (typeof schema.stockMovements.$inferSelect)[];
}

/** The only writer of stock movements. Balances follow via the database trigger. */
@Injectable()
export class LedgerService {
  constructor(private readonly db: Db) {}

  async record(input: OperationInput): Promise<OperationResult> {
    const tx = this.db.tx;
    const { tenantId } = currentTenant();
    const { user, device } = currentContext();

    const [operation] = await tx
      .insert(schema.inventoryOperations)
      .values({ tenantId, kind: input.kind, idempotencyKey: input.idempotencyKey ?? null, createdBy: user.userId })
      .onConflictDoNothing({ target: [schema.inventoryOperations.tenantId, schema.inventoryOperations.idempotencyKey] })
      .returning();

    if (!operation) {
      // Same key seen before: return what that request recorded.
      const [existing] = await tx
        .select()
        .from(schema.inventoryOperations)
        .where(eq(schema.inventoryOperations.idempotencyKey, input.idempotencyKey!));
      if (existing!.kind !== input.kind) {
        throw new BadRequestException('This idempotency key was already used for a different kind of operation');
      }
      return { operationId: existing!.id, replayed: true, movements: await this.movementsOf(existing!.id) };
    }

    await this.validate(input.lines);
    const movements = await tx
      .insert(schema.stockMovements)
      .values(
        input.lines.map((line) => ({
          tenantId,
          ...line,
          operationId: operation.id,
          referenceType: input.reference?.type ?? null,
          referenceId: input.reference?.id ?? null,
          note: input.note ?? null,
          actorUserId: user.userId,
          actorDeviceId: device?.id ?? null,
        })),
      )
      .returning();
    return { operationId: operation.id, replayed: false, movements };
  }

  private async validate(lines: MovementLine[]): Promise<void> {
    if (!lines.length) throw new BadRequestException('At least one line is required');
    const tx = this.db.tx;
    const locationIds = [...new Set(lines.map((l) => l.locationId))];
    const variantIds = [...new Set(lines.map((l) => l.variantId))];

    const locations = await tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(inArray(schema.locations.id, locationIds), isNull(schema.locations.archivedAt)));
    if (locations.length !== locationIds.length) throw new NotFoundException('Location not found or archived');

    const variants = await tx
      .select({ id: schema.productVariants.id, name: schema.productVariants.name, track: schema.productVariants.trackInventory })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, variantIds));
    if (variants.length !== variantIds.length) throw new NotFoundException('Product variant not found');
    const untracked = variants.filter((v) => !v.track);
    if (untracked.length) {
      throw new BadRequestException(`Inventory is not tracked for: ${untracked.map((v) => v.name).join(', ')}`);
    }
  }

  private movementsOf(operationId: string) {
    return this.db.tx
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.operationId, operationId))
      .orderBy(asc(schema.stockMovements.id));
  }
}

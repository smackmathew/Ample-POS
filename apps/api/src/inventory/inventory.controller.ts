import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, asc, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { ZodPipe } from '../core/zod';
import { LedgerService, type OperationResult } from './ledger.service';

const uuid = z.string().uuid();
const quantity = z.number().int().min(1).max(1_000_000);
const idempotencyKey = z.string().trim().min(8).max(100).optional();
const note = z.string().trim().max(500).optional();

const uniqueVariants = <T extends { variantId: string }>(lines: T[]) =>
  new Set(lines.map((l) => l.variantId)).size === lines.length;

const receiptBody = z.object({
  locationId: uuid,
  lines: z
    .array(z.object({ variantId: uuid, quantity }))
    .min(1)
    .max(500)
    .refine(uniqueVariants, 'each variant may appear once'),
  note,
  idempotencyKey,
});

const adjustmentBody = z.object({
  locationId: uuid,
  lines: z
    .array(z.object({ variantId: uuid, quantityDelta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'must not be zero') }))
    .min(1)
    .max(500)
    .refine(uniqueVariants, 'each variant may appear once'),
  note: z.string().trim().min(1, 'a reason is required for adjustments').max(500),
  idempotencyKey,
});

const transferBody = z
  .object({
    fromLocationId: uuid,
    toLocationId: uuid,
    lines: z
      .array(z.object({ variantId: uuid, quantity }))
      .min(1)
      .max(500)
      .refine(uniqueVariants, 'each variant may appear once'),
    note,
    idempotencyKey,
  })
  .refine((b) => b.fromLocationId !== b.toLocationId, 'source and destination must differ');

const levelsQuery = z.object({
  locationId: uuid,
  search: z.string().trim().max(100).optional(),
  /** Include tracked variants that have never had a movement here (on hand 0). */
  includeZero: z.enum(['true', 'false']).default('true'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const movementsQuery = z.object({
  locationId: uuid.optional(),
  variantId: uuid.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const summarize = (r: OperationResult) => ({
  operationId: r.operationId,
  replayed: r.replayed,
  movements: r.movements.map((m) => ({ id: m.id, locationId: m.locationId, variantId: m.variantId, quantityDelta: m.quantityDelta, reason: m.reason })),
});

@Controller('inventory')
@RequireModule('inventory')
export class InventoryController {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly events: Events,
  ) {}

  @RequirePermission('inventory.read')
  @Get('levels')
  async levels(@Query(new ZodPipe(levelsQuery)) q: z.infer<typeof levelsQuery>) {
    const v = schema.productVariants;
    const p = schema.products;
    const l = schema.stockLevels;
    const filters: (SQL | undefined)[] = [eq(v.trackInventory, true)];
    if (q.includeZero === 'false') filters.push(sql`${l.onHand} is not null and ${l.onHand} <> 0`);
    else filters.push(or(and(eq(v.status, 'active'), eq(p.status, 'active')), sql`${l.onHand} is not null`));
    if (q.search) {
      const term = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
      filters.push(or(ilike(p.name, term), ilike(v.name, term), ilike(v.sku, term)));
    }
    const rows = await this.db.tx
      .select({
        variantId: v.id,
        variantName: v.name,
        sku: v.sku,
        productId: p.id,
        productName: p.name,
        onHand: sql<number>`coalesce(${l.onHand}, 0)`.mapWith(Number),
        updatedAt: l.updatedAt,
      })
      .from(v)
      .innerJoin(p, eq(p.id, v.productId))
      .leftJoin(l, and(eq(l.variantId, v.id), eq(l.locationId, q.locationId)))
      .where(and(...filters))
      .orderBy(asc(sql`lower(${p.name})`), asc(v.position), asc(v.id))
      .limit(q.limit)
      .offset(q.offset);
    return { levels: rows, nextOffset: rows.length === q.limit ? q.offset + q.limit : null };
  }

  @RequirePermission('inventory.read')
  @Get('movements')
  async movements(@Query(new ZodPipe(movementsQuery)) q: z.infer<typeof movementsQuery>) {
    const m = schema.stockMovements;
    const rows = await this.db.tx
      .select({
        id: m.id,
        locationId: m.locationId,
        locationName: schema.locations.name,
        variantId: m.variantId,
        variantName: schema.productVariants.name,
        productName: schema.products.name,
        quantityDelta: m.quantityDelta,
        reason: m.reason,
        operationId: m.operationId,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        note: m.note,
        occurredAt: m.occurredAt,
        actor: { email: schema.users.email, displayName: schema.users.displayName },
      })
      .from(m)
      .innerJoin(schema.locations, eq(schema.locations.id, m.locationId))
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, m.variantId))
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.users, eq(schema.users.id, m.actorUserId))
      .where(
        and(
          q.locationId ? eq(m.locationId, q.locationId) : undefined,
          q.variantId ? eq(m.variantId, q.variantId) : undefined,
          q.before ? lt(m.id, q.before) : undefined,
        ),
      )
      .orderBy(desc(m.id))
      .limit(q.limit);
    return { movements: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
  }

  @RequirePermission('inventory.adjust')
  @Post('receipts')
  async receive(@Body(new ZodPipe(receiptBody)) body: z.infer<typeof receiptBody>) {
    const result = await this.ledger.record({
      kind: 'receipt',
      idempotencyKey: body.idempotencyKey,
      note: body.note,
      lines: body.lines.map((l) => ({ locationId: body.locationId, variantId: l.variantId, quantityDelta: l.quantity, reason: 'receive' })),
    });
    if (!result.replayed) await this.recordEvent('inventory.received', result);
    return summarize(result);
  }

  @RequirePermission('inventory.adjust')
  @Post('adjustments')
  async adjust(@Body(new ZodPipe(adjustmentBody)) body: z.infer<typeof adjustmentBody>) {
    const result = await this.ledger.record({
      kind: 'adjustment',
      idempotencyKey: body.idempotencyKey,
      note: body.note,
      lines: body.lines.map((l) => ({ locationId: body.locationId, variantId: l.variantId, quantityDelta: l.quantityDelta, reason: 'adjustment' })),
    });
    if (!result.replayed) await this.recordEvent('inventory.adjusted', result, { note: body.note });
    return summarize(result);
  }

  @RequirePermission('inventory.adjust')
  @Post('transfers')
  async transfer(@Body(new ZodPipe(transferBody)) body: z.infer<typeof transferBody>) {
    const result = await this.ledger.record({
      kind: 'transfer',
      idempotencyKey: body.idempotencyKey,
      note: body.note,
      lines: body.lines.flatMap((l) => [
        { locationId: body.fromLocationId, variantId: l.variantId, quantityDelta: -l.quantity, reason: 'transfer_out' as const },
        { locationId: body.toLocationId, variantId: l.variantId, quantityDelta: l.quantity, reason: 'transfer_in' as const },
      ]),
    });
    if (!result.replayed) {
      await this.recordEvent('inventory.transferred', result, { fromLocationId: body.fromLocationId, toLocationId: body.toLocationId });
    }
    return summarize(result);
  }

  private async recordEvent(action: string, result: OperationResult, extra: Record<string, unknown> = {}) {
    if (!result.movements.length) throw new BadRequestException('Nothing to record');
    await this.events.record(action, { type: 'operation', id: result.operationId }, {
      ...extra,
      lines: result.movements.map((m) => ({ locationId: m.locationId, variantId: m.variantId, quantityDelta: m.quantityDelta })),
    });
  }
}

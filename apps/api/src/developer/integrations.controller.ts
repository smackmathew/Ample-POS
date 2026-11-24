import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentContext, currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { LedgerService } from '../inventory/ledger.service';

const money = z.number().int().min(0).max(1_000_000_000_00);
const sku = z.string().trim().min(1).max(64);
const barcode = z.string().trim().regex(/^[!-~]{1,64}$/, 'printable characters only, max 64');

const upsertBody = z.object({
  products: z
    .array(
      z.object({
        sku,
        /** Product name. */
        name: z.string().trim().min(1).max(200),
        /** Variant name, e.g. "Large"; defaults to "Default". */
        variantName: z.string().trim().min(1).max(100).optional(),
        priceMinor: money,
        costMinor: money.nullable().optional(),
        category: z.string().trim().max(100).nullable().optional(),
        description: z.string().trim().max(5000).nullable().optional(),
        trackInventory: z.boolean().optional(),
        /** Replaces the variant's barcodes when present. */
        barcodes: z.array(barcode).max(20).optional(),
        status: z.enum(['active', 'archived']).optional(),
      }),
    )
    .min(1)
    .max(500)
    .refine((list) => new Set(list.map((p) => p.sku.toLowerCase())).size === list.length, 'each SKU may appear once'),
});

const levelsBody = z.object({
  locationId: z.string().uuid(),
  levels: z
    .array(
      z
        .object({ sku: sku.optional(), variantId: z.string().uuid().optional(), onHand: z.number().int().min(-1_000_000).max(1_000_000) })
        .refine((l) => Boolean(l.sku) !== Boolean(l.variantId), 'give either sku or variantId'),
    )
    .min(1)
    .max(1000),
  note: z.string().trim().max(500).optional(),
  /** Send the same key again to safely retry without applying twice. */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

type RowResult = { sku: string; status: 'created' | 'updated' | 'error'; productId?: string; variantId?: string; error?: string };

/**
 * Bulk endpoints for another app (a hub, an ERP, a supplier feed) that keeps
 * its own product list and stock counts and pushes them in. Rows are matched
 * by SKU; each row succeeds or fails on its own.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    private readonly ledger: LedgerService,
  ) {}

  /** Creates products that don't exist yet and updates the ones that do, by SKU. */
  @RequireModule('catalog')
  @RequirePermission('catalog.manage')
  @Post('products/upsert')
  @HttpCode(200)
  async upsertProducts(@Body(new ZodPipe(upsertBody)) body: z.infer<typeof upsertBody>) {
    const { tenantId } = currentTenant();
    const v = schema.productVariants;
    const existing = await this.db.tx
      .select({ id: v.id, productId: v.productId, sku: v.sku })
      .from(v)
      .where(inArray(sql`lower(${v.sku})`, body.products.map((p) => p.sku.toLowerCase())));
    const bySku = new Map(existing.map((e) => [e.sku!.toLowerCase(), e]));

    const results: RowResult[] = [];
    for (const row of body.products) {
      const found = bySku.get(row.sku.toLowerCase());
      try {
        // Each row in its own savepoint: a bad row doesn't undo the others.
        const result = await this.db.tx.transaction(async (sp) => {
          if (found) {
            await sp
              .update(schema.products)
              .set({
                name: row.name,
                ...(row.category !== undefined ? { category: row.category } : {}),
                ...(row.description !== undefined ? { description: row.description } : {}),
                version: sql`${schema.products.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(schema.products.id, found.productId));
            await sp
              .update(v)
              .set({
                priceMinor: row.priceMinor,
                ...(row.variantName ? { name: row.variantName } : {}),
                ...(row.costMinor !== undefined ? { costMinor: row.costMinor } : {}),
                ...(row.trackInventory !== undefined ? { trackInventory: row.trackInventory } : {}),
                ...(row.status ? { status: row.status } : {}),
                version: sql`${v.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(v.id, found.id));
            if (row.barcodes) {
              await sp.delete(schema.variantBarcodes).where(eq(schema.variantBarcodes.variantId, found.id));
              if (row.barcodes.length) await sp.insert(schema.variantBarcodes).values(row.barcodes.map((b) => ({ tenantId, variantId: found.id, barcode: b })));
            }
            return { status: 'updated' as const, productId: found.productId, variantId: found.id };
          }
          const [product] = await sp
            .insert(schema.products)
            .values({ tenantId, name: row.name, category: row.category ?? null, description: row.description ?? null, status: row.status ?? 'active' })
            .returning({ id: schema.products.id });
          const [variant] = await sp
            .insert(v)
            .values({
              tenantId,
              productId: product!.id,
              name: row.variantName ?? 'Default',
              sku: row.sku,
              priceMinor: row.priceMinor,
              costMinor: row.costMinor ?? null,
              trackInventory: row.trackInventory ?? true,
              status: row.status ?? 'active',
            })
            .returning({ id: v.id });
          if (row.barcodes?.length) await sp.insert(schema.variantBarcodes).values(row.barcodes.map((b) => ({ tenantId, variantId: variant!.id, barcode: b })));
          return { status: 'created' as const, productId: product!.id, variantId: variant!.id };
        });
        if (result.status === 'created') {
          await this.events.record('product.created', { type: 'product', id: result.productId }, { name: row.name, sku: row.sku, source: 'api' });
        } else {
          await this.events.record('variant.updated', { type: 'variant', id: result.variantId }, { productId: result.productId, sku: row.sku, priceMinor: row.priceMinor, source: 'api' });
        }
        results.push({ sku: row.sku, ...result });
      } catch (err) {
        results.push({ sku: row.sku, status: 'error', error: friendly(err) });
      }
    }
    return summary(results);
  }

  /**
   * Sets on-hand counts at one location to the numbers given (not +/-).
   * Recorded as one stock adjustment, so history and reports stay correct.
   */
  @RequireModule('inventory')
  @RequirePermission('inventory.adjust')
  @Post('inventory/levels')
  @HttpCode(200)
  async setLevels(@Body(new ZodPipe(levelsBody)) body: z.infer<typeof levelsBody>) {
    const v = schema.productVariants;
    const skus = body.levels.filter((l) => l.sku).map((l) => l.sku!.toLowerCase());
    const ids = body.levels.filter((l) => l.variantId).map((l) => l.variantId!);
    const variants = await this.db.tx
      .select({ id: v.id, sku: v.sku, track: v.trackInventory })
      .from(v)
      .where(
        sql`${skus.length ? inArray(sql`lower(${v.sku})`, skus) : sql`false`} or ${ids.length ? inArray(v.id, ids) : sql`false`}`,
      );
    const bySku = new Map(variants.filter((x) => x.sku).map((x) => [x.sku!.toLowerCase(), x]));
    const byId = new Map(variants.map((x) => [x.id, x]));

    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, body.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new BadRequestException('Location not found or archived');

    const current = variants.length
      ? await this.db.tx
          .select({ variantId: schema.stockLevels.variantId, onHand: schema.stockLevels.onHand })
          .from(schema.stockLevels)
          .where(and(eq(schema.stockLevels.locationId, body.locationId), inArray(schema.stockLevels.variantId, variants.map((x) => x.id))))
      : [];
    const onHand = new Map(current.map((c) => [c.variantId, c.onHand]));

    type LevelResult = { sku: string | null; variantId: string | null; status: 'set' | 'unchanged' | 'error'; before?: number; after?: number; error?: string };
    const results: LevelResult[] = [];
    const lines: { variantId: string; quantityDelta: number }[] = [];
    const seen = new Set<string>();
    for (const level of body.levels) {
      const variant = level.sku ? bySku.get(level.sku.toLowerCase()) : byId.get(level.variantId!);
      const ref = { sku: level.sku ?? variant?.sku ?? null, variantId: variant?.id ?? level.variantId ?? null };
      if (!variant) {
        results.push({ ...ref, status: 'error', error: 'No product with this SKU' });
        continue;
      }
      if (!variant.track) {
        results.push({ ...ref, status: 'error', error: 'Inventory isn’t tracked for this product' });
        continue;
      }
      if (seen.has(variant.id)) {
        results.push({ ...ref, status: 'error', error: 'Listed more than once' });
        continue;
      }
      seen.add(variant.id);
      const before = onHand.get(variant.id) ?? 0;
      if (before === level.onHand) {
        results.push({ ...ref, status: 'unchanged', before, after: before });
        continue;
      }
      lines.push({ variantId: variant.id, quantityDelta: level.onHand - before });
      results.push({ ...ref, status: 'set', before, after: level.onHand });
    }

    let operationId: string | null = null;
    if (lines.length) {
      const note = body.note ?? `Stock levels set by ${currentContext().apiKey?.name ?? 'an integration'}`;
      const result = await this.ledger.record({
        kind: 'adjustment',
        idempotencyKey: body.idempotencyKey,
        note,
        lines: lines.map((l) => ({ locationId: body.locationId, ...l, reason: 'adjustment' as const })),
      });
      operationId = result.operationId;
      if (!result.replayed) {
        await this.events.record('inventory.adjusted', { type: 'operation', id: result.operationId }, { note, source: 'api', lines: result.movements.map((m) => ({ locationId: m.locationId, variantId: m.variantId, quantityDelta: m.quantityDelta })) });
      }
    }
    return {
      operationId,
      set: results.filter((r) => r.status === 'set').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
    };
  }
}

function summary(results: RowResult[]) {
  return {
    created: results.filter((r) => r.status === 'created').length,
    updated: results.filter((r) => r.status === 'updated').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
}

/** Database errors in plain words. */
function friendly(err: unknown): string {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: string; constraint_name?: string; message?: string };
    if (pg.code === '23505') return pg.constraint_name?.includes('barcode') ? 'A barcode is already used by another product' : 'Already exists';
    if (pg.code === '23514') return 'A value is out of range';
  }
  return (err as Error)?.message ?? 'Could not save';
}

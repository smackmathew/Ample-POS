import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { schema } from '@pos/db';
import { getModule, type ModuleId } from '@pos/modules';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { LedgerService } from '../inventory/ledger.service';
import { parseCsv } from './csv';
import { autoMap, FIELDS, normalize, type CustomerRow, type ImportKind, type ImportSource, type NormalizedRow, type ProductRow, type SupplierRow } from './presets';

export const MAX_ROWS = 20_000;
const SOURCE_NAME: Record<ImportSource, string> = { qbpos: 'QuickBooks POS', ample: 'an Ample POS export', other: 'a spreadsheet' };
const TOOL_FOR: Record<ImportKind, ModuleId> = { products: 'catalog', customers: 'customers', suppliers: 'purchasing' };

type Batch = typeof schema.importBatches.$inferSelect;
type Action = 'create' | 'update' | 'error';
export interface Planned {
  line: number;
  action: Action;
  label: string;
  errors: string[];
}

/**
 * Brings another system's data in: a CSV becomes a batch, previewed (what
 * would be created or updated, and problems), then imported in one go and
 * recorded so it can be undone.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    private readonly ledger: LedgerService,
  ) {}

  async start(input: { kind: ImportKind; source: ImportSource; fileName: string; csv: string; locationId?: string | null }) {
    await this.requireTool(TOOL_FOR[input.kind]);
    const [headers, ...rows] = parseCsv(input.csv);
    if (!headers?.length) throw new BadRequestException('The file is empty');
    if (!rows.length) throw new BadRequestException('The file has a header row but no data');
    if (rows.length > MAX_ROWS) throw new BadRequestException(`Up to ${MAX_ROWS.toLocaleString('en-US')} rows per file; split it and import each part`);
    const cleanHeaders = headers.map((h, i) => h.trim() || `Column ${i + 1}`);
    const locationId = input.kind === 'products' ? (input.locationId ?? null) : null;
    if (locationId) await this.requireLocation(locationId);
    const [batch] = await this.db.tx
      .insert(schema.importBatches)
      .values({
        tenantId: currentTenant().tenantId,
        kind: input.kind,
        source: input.source,
        fileName: input.fileName.slice(0, 200),
        locationId,
        headers: cleanHeaders,
        rows,
        mapping: autoMap(input.kind, input.source, cleanHeaders),
        createdBy: currentUserId(),
      })
      .returning();
    return this.preview(batch!.id);
  }

  async list() {
    const b = schema.importBatches;
    return this.db.tx
      .select({
        id: b.id,
        kind: b.kind,
        source: b.source,
        fileName: b.fileName,
        status: b.status,
        stats: b.stats,
        createdAt: b.createdAt,
        committedAt: b.committedAt,
        undoneAt: b.undoneAt,
        by: schema.users.displayName,
      })
      .from(b)
      .leftJoin(schema.users, eq(schema.users.id, b.createdBy))
      .orderBy(desc(b.createdAt))
      .limit(50);
  }

  /** What importing would do, row by row, with the column mapping. */
  async preview(id: string) {
    const batch = await this.find(id);
    if (batch.status !== 'preview' || !batch.rows) {
      return { batch: this.summary(batch), fields: FIELDS[batch.kind].map(({ key, label }) => ({ key, label })), planned: [], counts: batch.stats };
    }
    const rows = normalize(batch.kind, batch.headers, batch.rows, batch.mapping);
    const planned = await this.plan(batch, rows);
    const counts = { rows: planned.length, create: 0, update: 0, error: 0, warnings: 0 };
    for (const p of planned) {
      counts[p.action]++;
      if (p.action !== 'error' && p.errors.length) counts.warnings++;
    }
    return {
      batch: this.summary(batch),
      fields: FIELDS[batch.kind].map(({ key, label }) => ({ key, label })),
      counts,
      // The first rows, then every row with a problem.
      planned: [...planned.slice(0, 25), ...planned.slice(25).filter((p) => p.errors.length)].slice(0, 300),
    };
  }

  async remap(id: string, mapping: Record<string, string | null>, locationId?: string | null) {
    const batch = await this.find(id);
    if (batch.status !== 'preview') throw new ConflictException('This import has already been run');
    const fields = new Set(FIELDS[batch.kind].map((f) => f.key));
    const headers = new Set(batch.headers);
    const clean: Record<string, string | null> = {};
    for (const key of fields) {
      const col = mapping[key];
      if (col && !headers.has(col)) throw new BadRequestException(`The file has no column “${col}”`);
      clean[key] = col || null;
    }
    if (locationId) await this.requireLocation(locationId);
    await this.db.tx
      .update(schema.importBatches)
      .set({ mapping: clean, ...(locationId !== undefined && batch.kind === 'products' ? { locationId } : {}) })
      .where(eq(schema.importBatches.id, id));
    return this.preview(id);
  }

  /** Runs the import. Each row is saved on its own, so one bad row doesn't stop the rest. */
  async commit(id: string) {
    const batch = await this.find(id);
    if (batch.status !== 'preview' || !batch.rows) throw new ConflictException('This import has already been run');
    await this.requireTool(TOOL_FOR[batch.kind]);
    const rows = normalize(batch.kind, batch.headers, batch.rows, batch.mapping);
    const stats: { counts: Record<string, number>; failures: { line: number; error: string }[]; operationId?: string } =
      batch.kind === 'products'
        ? await this.importProducts(batch, rows as NormalizedRow<ProductRow>[])
        : batch.kind === 'customers'
          ? await this.importCustomers(batch, rows as NormalizedRow<CustomerRow>[])
          : await this.importSuppliers(batch, rows as NormalizedRow<SupplierRow>[]);
    await this.db.tx
      .update(schema.importBatches)
      .set({ status: 'committed', committedAt: new Date(), rows: null, stats: stats.counts, operationId: stats.operationId ?? null })
      .where(eq(schema.importBatches.id, id));
    await this.events.audit('import.committed', { type: 'import', id }, { kind: batch.kind, source: batch.source, fileName: batch.fileName, ...stats.counts });
    return { ...stats.counts, failures: stats.failures.slice(0, 200) };
  }

  /** Takes an import back out: new records archived or removed, changed ones restored, stock reversed. */
  async undo(id: string) {
    const batch = await this.find(id);
    if (batch.status !== 'committed') throw new ConflictException('Only a finished import can be undone');
    const tx = this.db.tx;
    const items = await tx.select().from(schema.importBatchItems).where(eq(schema.importBatchItems.batchId, id)).orderBy(desc(schema.importBatchItems.id));
    let kept = 0;

    if (batch.operationId) {
      const moves = await tx.select().from(schema.stockMovements).where(eq(schema.stockMovements.operationId, batch.operationId));
      const back = moves.filter((m) => m.quantityDelta !== 0);
      if (back.length) {
        await this.ledger.record({
          kind: 'adjustment',
          note: `Undo import of ${batch.fileName}`,
          reference: { type: 'import', id },
          lines: back.map((m) => ({ locationId: m.locationId, variantId: m.variantId, quantityDelta: -m.quantityDelta, reason: 'adjustment' as const })),
        });
      }
    }

    for (const item of items) {
      const before = item.before ?? {};
      switch (`${item.entityType}:${item.action}`) {
        case 'barcode:created':
          await tx.delete(schema.variantBarcodes).where(eq(schema.variantBarcodes.barcode, item.entityId));
          break;
        case 'variant:created':
          await tx.update(schema.productVariants).set({ status: 'archived', updatedAt: new Date() }).where(eq(schema.productVariants.id, item.entityId));
          break;
        case 'product:created':
          await tx.update(schema.products).set({ status: 'archived', updatedAt: new Date() }).where(eq(schema.products.id, item.entityId));
          break;
        case 'variant:updated':
          await tx.update(schema.productVariants).set({ ...(before as object), updatedAt: new Date() }).where(eq(schema.productVariants.id, item.entityId));
          break;
        case 'product:updated':
          await tx.update(schema.products).set({ ...(before as object), updatedAt: new Date() }).where(eq(schema.products.id, item.entityId));
          break;
        case 'customer:created': {
          // Keep customers who have bought something since the import.
          const [{ n }] = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from sales where customer_id = ${item.entityId}`)) as unknown as [{ n: number }];
          if (n > 0) kept++;
          else await tx.delete(schema.customers).where(eq(schema.customers.id, item.entityId));
          break;
        }
        case 'customer:updated':
          await tx.update(schema.customers).set({ ...(before as object), updatedAt: new Date() }).where(eq(schema.customers.id, item.entityId));
          break;
        case 'supplier:created':
          await tx.update(schema.suppliers).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.suppliers.id, item.entityId));
          break;
        case 'supplier:updated':
          await tx.update(schema.suppliers).set({ ...(before as object), updatedAt: new Date() }).where(eq(schema.suppliers.id, item.entityId));
          break;
      }
    }
    await tx.update(schema.importBatches).set({ status: 'undone', undoneAt: new Date() }).where(eq(schema.importBatches.id, id));
    await this.events.audit('import.undone', { type: 'import', id }, { kind: batch.kind, fileName: batch.fileName, kept });
    return { undone: true, kept };
  }

  // --- planning (preview) -------------------------------------------------

  private async plan(batch: Batch, rows: NormalizedRow<ProductRow | CustomerRow | SupplierRow>[]): Promise<Planned[]> {
    const fail = (r: NormalizedRow<unknown>): Planned => ({ line: r.line, action: 'error', label: '', errors: r.errors });
    if (batch.kind === 'products') {
      const data = rows.flatMap((r) => (r.data ? [r.data as ProductRow] : []));
      const { bySku, byBarcode } = await this.existingVariants(data);
      const seen = new Set<string>();
      return rows.map((r) => {
        if (!r.data) return fail(r);
        const d = r.data as ProductRow;
        const key = d.sku?.toLowerCase();
        const dup = key && seen.has(key);
        if (key) seen.add(key);
        const found = (key && bySku.get(key)) || d.barcodes.map((b) => byBarcode.get(b)).find(Boolean);
        const label = `${d.name}${d.variant !== 'Default' ? ` — ${d.variant}` : ''}`;
        if (dup) return { line: r.line, action: 'error', label, errors: [`SKU ${d.sku} appears more than once in the file`] };
        const errors = [...r.errors];
        if (d.onHand !== null && !batch.locationId) errors.push('Has a quantity, but no location was chosen; stock won’t be set');
        return { line: r.line, action: found ? 'update' : 'create', label, errors };
      });
    }
    if (batch.kind === 'customers') {
      const data = rows.flatMap((r) => (r.data ? [r.data as CustomerRow] : []));
      const existing = await this.existingCustomers(data);
      return rows.map((r) => {
        if (!r.data) return fail(r);
        const d = r.data as CustomerRow;
        const found = (d.email && existing.byEmail.get(d.email)) || (d.phone && existing.byPhone.get(d.phone));
        return { line: r.line, action: found ? 'update' : 'create', label: d.name, errors: r.errors };
      });
    }
    const data = rows.flatMap((r) => (r.data ? [r.data as SupplierRow] : []));
    const existing = await this.existingSuppliers(data);
    return rows.map((r) => {
      if (!r.data) return fail(r);
      const d = r.data as SupplierRow;
      return { line: r.line, action: existing.has(d.name.toLowerCase()) ? 'update' : 'create', label: d.name, errors: r.errors };
    });
  }

  private async existingVariants(rows: ProductRow[]) {
    const v = schema.productVariants;
    const skus = [...new Set(rows.flatMap((r) => (r.sku ? [r.sku.toLowerCase()] : [])))];
    const barcodes = [...new Set(rows.flatMap((r) => r.barcodes))];
    const bySku = new Map<string, { id: string; productId: string }>();
    const byBarcode = new Map<string, { id: string; productId: string }>();
    for (let i = 0; i < skus.length; i += 1000) {
      const found = await this.db.tx
        .select({ id: v.id, productId: v.productId, sku: v.sku })
        .from(v)
        .where(inArray(sql`lower(${v.sku})`, skus.slice(i, i + 1000)));
      for (const f of found) bySku.set(f.sku!.toLowerCase(), f);
    }
    for (let i = 0; i < barcodes.length; i += 1000) {
      const found = await this.db.tx
        .select({ barcode: schema.variantBarcodes.barcode, id: v.id, productId: v.productId })
        .from(schema.variantBarcodes)
        .innerJoin(v, eq(v.id, schema.variantBarcodes.variantId))
        .where(inArray(schema.variantBarcodes.barcode, barcodes.slice(i, i + 1000)));
      for (const f of found) byBarcode.set(f.barcode, f);
    }
    return { bySku, byBarcode };
  }

  private async existingCustomers(rows: CustomerRow[]) {
    const c = schema.customers;
    const emails = [...new Set(rows.flatMap((r) => (r.email ? [r.email] : [])))];
    const phones = [...new Set(rows.flatMap((r) => (r.phone ? [r.phone] : [])))];
    const byEmail = new Map<string, typeof c.$inferSelect>();
    const byPhone = new Map<string, typeof c.$inferSelect>();
    for (let i = 0; i < emails.length; i += 1000) for (const f of await this.db.tx.select().from(c).where(inArray(c.email, emails.slice(i, i + 1000)))) byEmail.set(f.email!, f);
    for (let i = 0; i < phones.length; i += 1000) for (const f of await this.db.tx.select().from(c).where(inArray(c.phone, phones.slice(i, i + 1000)))) byPhone.set(f.phone!, f);
    return { byEmail, byPhone };
  }

  private async existingSuppliers(rows: SupplierRow[]) {
    const s = schema.suppliers;
    const names = [...new Set(rows.map((r) => r.name.toLowerCase()))];
    const out = new Map<string, typeof s.$inferSelect>();
    for (let i = 0; i < names.length; i += 1000) {
      const found = await this.db.tx
        .select()
        .from(s)
        .where(and(isNull(s.archivedAt), inArray(sql`lower(${s.name})`, names.slice(i, i + 1000))));
      for (const f of found) out.set(f.name.toLowerCase(), f);
    }
    return out;
  }

  // --- importing -----------------------------------------------------------

  private async importProducts(batch: Batch, rows: NormalizedRow<ProductRow>[]) {
    const tx = this.db.tx;
    const { tenantId } = currentTenant();
    const data = rows.flatMap((r) => (r.data ? [r.data] : []));
    const { bySku, byBarcode } = await this.existingVariants(data);
    // Rows with the same product name and a variant (color, size...) become one product.
    const newProducts = new Map<string, { id: string; variants: number }>();
    const stock: { variantId: string; onHand: number }[] = [];
    const failures: { line: number; error: string }[] = rows.filter((r) => !r.data).map((r) => ({ line: r.line, error: r.errors.join('; ') }));
    const counts = { created: 0, updated: 0, failed: failures.length, stockSet: 0 };
    const seenSku = new Set<string>();

    for (const r of rows) {
      if (!r.data) continue;
      const d = r.data;
      const key = d.sku?.toLowerCase();
      if (key && seenSku.has(key)) {
        failures.push({ line: r.line, error: `SKU ${d.sku} appears more than once in the file` });
        counts.failed++;
        continue;
      }
      if (key) seenSku.add(key);
      try {
        const variantId = await tx.transaction(async (sp) => {
          const found = (key && bySku.get(key)) || d.barcodes.map((b) => byBarcode.get(b)).find(Boolean);
          const items: Omit<typeof schema.importBatchItems.$inferInsert, 'tenantId' | 'batchId'>[] = [];
          let id: string;
          if (found) {
            const [pv] = await sp
              .select({ name: schema.productVariants.name, priceMinor: schema.productVariants.priceMinor, costMinor: schema.productVariants.costMinor, status: schema.productVariants.status })
              .from(schema.productVariants)
              .where(eq(schema.productVariants.id, found.id));
            const [pp] = await sp
              .select({ name: schema.products.name, category: schema.products.category, status: schema.products.status })
              .from(schema.products)
              .where(eq(schema.products.id, found.productId));
            await sp
              .update(schema.productVariants)
              .set({
                priceMinor: d.priceMinor,
                ...(d.costMinor !== null ? { costMinor: d.costMinor } : {}),
                ...(d.variant !== 'Default' ? { name: d.variant } : {}),
                status: 'active',
                version: sql`${schema.productVariants.version} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(schema.productVariants.id, found.id));
            await sp
              .update(schema.products)
              .set({ ...(d.category ? { category: d.category } : {}), status: 'active', version: sql`${schema.products.version} + 1`, updatedAt: new Date() })
              .where(eq(schema.products.id, found.productId));
            items.push({ entityType: 'variant', entityId: found.id, action: 'updated', before: pv ?? null }, { entityType: 'product', entityId: found.productId, action: 'updated', before: pp ?? null });
            id = found.id;
          } else {
            const groupKey = d.variant !== 'Default' ? d.name.toLowerCase() : null;
            let product = groupKey ? newProducts.get(groupKey) : undefined;
            if (!product) {
              const [created] = await sp
                .insert(schema.products)
                .values({ tenantId, name: d.name, category: d.category })
                .returning({ id: schema.products.id });
              product = { id: created!.id, variants: 0 };
              if (groupKey) newProducts.set(groupKey, product);
              items.push({ entityType: 'product', entityId: product.id, action: 'created', before: null });
            }
            const [variant] = await sp
              .insert(schema.productVariants)
              .values({ tenantId, productId: product.id, name: d.variant, sku: d.sku, priceMinor: d.priceMinor, costMinor: d.costMinor, position: product.variants++ })
              .returning({ id: schema.productVariants.id });
            items.push({ entityType: 'variant', entityId: variant!.id, action: 'created', before: null });
            id = variant!.id;
          }
          for (const barcode of d.barcodes) {
            const [added] = await sp
              .insert(schema.variantBarcodes)
              .values({ tenantId, variantId: id, barcode })
              .onConflictDoNothing()
              .returning({ barcode: schema.variantBarcodes.barcode });
            if (added) items.push({ entityType: 'barcode', entityId: barcode, action: 'created', before: null });
          }
          await sp.insert(schema.importBatchItems).values(items.map((i) => ({ ...i, tenantId, batchId: batch.id })));
          return { id, created: !found };
        });
        if (variantId.created) counts.created++;
        else counts.updated++;
        if (d.onHand !== null && batch.locationId) stock.push({ variantId: variantId.id, onHand: d.onHand });
      } catch (err) {
        counts.failed++;
        failures.push({ line: r.line, error: friendly(err) });
      }
    }

    let operationId: string | undefined;
    if (stock.length && batch.locationId) {
      await this.requireTool('inventory');
      const tracked = await tx
        .select({ id: schema.productVariants.id })
        .from(schema.productVariants)
        .where(and(inArray(schema.productVariants.id, stock.map((s) => s.variantId)), eq(schema.productVariants.trackInventory, true)));
      const trackedIds = new Set(tracked.map((t) => t.id));
      const current = await tx
        .select({ variantId: schema.stockLevels.variantId, onHand: schema.stockLevels.onHand })
        .from(schema.stockLevels)
        .where(and(eq(schema.stockLevels.locationId, batch.locationId), inArray(schema.stockLevels.variantId, [...trackedIds])));
      const onHand = new Map(current.map((c) => [c.variantId, c.onHand]));
      const lines = stock
        .filter((s) => trackedIds.has(s.variantId))
        .map((s) => ({ locationId: batch.locationId!, variantId: s.variantId, quantityDelta: s.onHand - (onHand.get(s.variantId) ?? 0), reason: 'adjustment' as const }))
        .filter((l) => l.quantityDelta !== 0);
      if (lines.length) {
        const note = `Imported from ${SOURCE_NAME[batch.source]}: ${batch.fileName}`;
        const result = await this.ledger.record({ kind: 'adjustment', note, reference: { type: 'import', id: batch.id }, lines });
        operationId = result.operationId;
        counts.stockSet = lines.length;
        await this.events.record('inventory.adjusted', { type: 'operation', id: result.operationId }, { note, source: 'import', lines: lines.map(({ reason: _r, ...l }) => l) });
      }
    }
    return { counts, failures, operationId };
  }

  private async importCustomers(batch: Batch, rows: NormalizedRow<CustomerRow>[]) {
    const tx = this.db.tx;
    const { tenantId } = currentTenant();
    const existing = await this.existingCustomers(rows.flatMap((r) => (r.data ? [r.data] : [])));
    const failures = rows.filter((r) => !r.data).map((r) => ({ line: r.line, error: r.errors.join('; ') }));
    const counts = { created: 0, updated: 0, failed: failures.length };
    for (const r of rows) {
      if (!r.data) continue;
      const d = r.data;
      try {
        await tx.transaction(async (sp) => {
          const found = (d.email && existing.byEmail.get(d.email)) || (d.phone && existing.byPhone.get(d.phone)) || null;
          if (found) {
            const before = { name: found.name, email: found.email, phone: found.phone, note: found.note };
            await sp
              .update(schema.customers)
              .set({ name: d.name, ...(d.email ? { email: d.email } : {}), ...(d.phone ? { phone: d.phone } : {}), ...(d.note ? { note: d.note } : {}), updatedAt: new Date() })
              .where(eq(schema.customers.id, found.id));
            await sp.insert(schema.importBatchItems).values({ tenantId, batchId: batch.id, entityType: 'customer', entityId: found.id, action: 'updated', before });
            counts.updated++;
          } else {
            const [c] = await sp.insert(schema.customers).values({ tenantId, ...d, createdBy: currentUserId() }).returning();
            await sp.insert(schema.importBatchItems).values({ tenantId, batchId: batch.id, entityType: 'customer', entityId: c!.id, action: 'created', before: null });
            // Later rows in the file with the same email or phone update this one.
            if (c!.email) existing.byEmail.set(c!.email, c!);
            if (c!.phone) existing.byPhone.set(c!.phone, c!);
            counts.created++;
          }
        });
      } catch (err) {
        counts.failed++;
        failures.push({ line: r.line, error: friendly(err) });
      }
    }
    return { counts, failures };
  }

  private async importSuppliers(batch: Batch, rows: NormalizedRow<SupplierRow>[]) {
    const tx = this.db.tx;
    const { tenantId } = currentTenant();
    const existing = await this.existingSuppliers(rows.flatMap((r) => (r.data ? [r.data] : [])));
    const failures = rows.filter((r) => !r.data).map((r) => ({ line: r.line, error: r.errors.join('; ') }));
    const counts = { created: 0, updated: 0, failed: failures.length };
    for (const r of rows) {
      if (!r.data) continue;
      const d = r.data;
      try {
        await tx.transaction(async (sp) => {
          const found = existing.get(d.name.toLowerCase());
          if (found) {
            const before = { name: found.name, contactName: found.contactName, email: found.email, phone: found.phone, notes: found.notes };
            await sp
              .update(schema.suppliers)
              .set({
                ...(d.contactName ? { contactName: d.contactName } : {}),
                ...(d.email ? { email: d.email } : {}),
                ...(d.phone ? { phone: d.phone } : {}),
                ...(d.notes ? { notes: d.notes } : {}),
                updatedAt: new Date(),
              })
              .where(eq(schema.suppliers.id, found.id));
            await sp.insert(schema.importBatchItems).values({ tenantId, batchId: batch.id, entityType: 'supplier', entityId: found.id, action: 'updated', before });
            counts.updated++;
          } else {
            const [s] = await sp.insert(schema.suppliers).values({ tenantId, ...d }).returning();
            await sp.insert(schema.importBatchItems).values({ tenantId, batchId: batch.id, entityType: 'supplier', entityId: s!.id, action: 'created', before: null });
            existing.set(s!.name.toLowerCase(), s!);
            counts.created++;
          }
        });
      } catch (err) {
        counts.failed++;
        failures.push({ line: r.line, error: friendly(err) });
      }
    }
    return { counts, failures };
  }

  // --- helpers -----------------------------------------------------------------

  private async find(id: string): Promise<Batch> {
    const [batch] = await this.db.tx.select().from(schema.importBatches).where(eq(schema.importBatches.id, id));
    if (!batch) throw new NotFoundException('Import not found');
    return batch;
  }

  private summary(b: Batch) {
    return { id: b.id, kind: b.kind, source: b.source, fileName: b.fileName, locationId: b.locationId, status: b.status, headers: b.headers, mapping: b.mapping, stats: b.stats, createdAt: b.createdAt };
  }

  async requireTool(moduleId: ModuleId) {
    const [row] = await this.db.tx
      .select({ enabled: schema.tenantModules.enabled })
      .from(schema.tenantModules)
      .where(eq(schema.tenantModules.moduleId, moduleId));
    if (!row?.enabled) throw new ForbiddenException(`Turn on ${getModule(moduleId).name} in Tools first`);
  }

  private async requireLocation(id: string) {
    const [loc] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, id), isNull(schema.locations.archivedAt)));
    if (!loc) throw new BadRequestException('Location not found');
  }
}

/** Database errors in plain words. */
function friendly(err: unknown): string {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: string; constraint_name?: string; message?: string };
    if (pg.code === '23505') {
      if (pg.constraint_name?.includes('sku')) return 'Another product already uses this SKU';
      if (pg.constraint_name?.includes('email')) return 'Another customer already uses this email';
      if (pg.constraint_name?.includes('phone')) return 'Another customer already uses this phone number';
      return 'Already exists';
    }
    if (pg.code === '23514') return 'A value is out of range';
  }
  return (err as Error)?.message ?? 'Could not save';
}


import { ConflictException, Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ImportsService } from './imports.service';
import {
  normalize,
  type CustomerRow,
  type GiftCardRow,
  type ImportKind,
  type LoyaltyRow,
  type ProductRow,
  type SaleHistoryRow,
  type SupplierRow,
} from './presets';

type Batch = typeof schema.importBatches.$inferSelect;
export type Unit = 'count' | 'units' | 'money' | 'points';

export interface Check {
  key: string;
  label: string;
  unit: Unit;
  /** What the file said. */
  file: number;
  /** What Ample POS has now. */
  ample: number;
  ok: boolean;
  note?: string;
}

export interface Difference {
  line: number;
  item: string;
  problem: string;
  file: string | null;
  ample: string | null;
}

export interface ImportReport {
  id: string;
  kind: ImportKind;
  fileName: string;
  committedAt: Date | null;
  location: string | null;
  rows: number;
  skippedRows: number;
  /** False for files imported before the report existed: their rows weren't kept, so there's nothing to compare. */
  fileKept: boolean;
  checks: Check[];
  differences: Difference[];
  differenceCount: number;
}

const MAX_DIFFERENCES = 200;
const money = (minor: number) => (minor / 100).toFixed(2);
const check = (key: string, label: string, unit: Unit, file: number, ample: number, note?: string): Check => ({
  key,
  label,
  unit,
  file,
  ample,
  ok: file === ample,
  note,
});

/**
 * The reconciliation report: for each import, what the file from the old
 * system said against what Ample POS has now, found the same way the import
 * matched them (item number, then barcode; customer email, phone or name;
 * gift card code). Owners sign it off once the numbers agree, or the
 * differences are explained.
 */
@Injectable()
export class ImportReconciliation {
  constructor(
    private readonly db: Db,
    private readonly imports: ImportsService,
    private readonly events: Events,
  ) {}

  async report() {
    const b = schema.importBatches;
    const batches = await this.db.tx.select().from(b).where(eq(b.status, 'committed')).orderBy(b.committedAt);
    const imports: ImportReport[] = [];
    for (const batch of batches) imports.push(await this.forBatch(batch));
    const [signoff] = await this.db.tx
      .select({
        id: schema.migrationSignoffs.id,
        signedAt: schema.migrationSignoffs.signedAt,
        note: schema.migrationSignoffs.note,
        by: schema.users.displayName,
        email: schema.users.email,
      })
      .from(schema.migrationSignoffs)
      .leftJoin(schema.users, eq(schema.users.id, schema.migrationSignoffs.signedBy))
      .orderBy(desc(schema.migrationSignoffs.signedAt))
      .limit(1);
    const checks = imports.flatMap((i) => i.checks);
    return {
      generatedAt: new Date(),
      imports,
      summary: {
        imports: imports.length,
        checks: checks.length,
        matching: checks.filter((c) => c.ok).length,
        differences: imports.reduce((t, i) => t + i.differenceCount, 0),
      },
      signoff: signoff ? { ...signoff, by: signoff.by ?? signoff.email } : null,
    };
  }

  /** The owner accepts the report as it stands now. */
  async signOff(note: string | null) {
    const report = await this.report();
    if (!report.imports.length) throw new ConflictException('Nothing has been imported yet, so there’s nothing to sign off');
    // Keep the numbers, not every line of differences.
    const kept = { summary: report.summary, imports: report.imports.map(({ differences: _d, ...rest }) => rest) };
    const [row] = await this.db.tx
      .insert(schema.migrationSignoffs)
      .values({ tenantId: currentTenant().tenantId, signedBy: currentUserId(), note, report: kept })
      .returning({ id: schema.migrationSignoffs.id });
    await this.events.audit('migration.signed_off', { type: 'migration_signoff', id: row!.id }, { note, ...report.summary });
    return this.report();
  }

  /** The report as CSV, for an accountant or the owner's records. */
  async csv() {
    const report = await this.report();
    const fmt = (unit: Unit, n: number) => (unit === 'money' ? money(n) : String(n));
    const lines: (string | number | null)[][] = [['Import', 'What', 'Check', 'In the file', 'In Ample POS', 'Difference', 'Matches']];
    for (const i of report.imports) {
      for (const c of i.checks) {
        lines.push([i.fileName, i.kind, c.label, fmt(c.unit, c.file), fmt(c.unit, c.ample), fmt(c.unit, c.ample - c.file), c.ok ? 'yes' : 'no']);
      }
    }
    lines.push([]);
    lines.push(['Import', 'Line', 'Item', 'Problem', 'In the file', 'In Ample POS']);
    for (const i of report.imports) for (const d of i.differences) lines.push([i.fileName, d.line, d.item, d.problem, d.file, d.ample]);
    return lines;
  }

  // --- per kind -----------------------------------------------------------------

  private async forBatch(batch: Batch): Promise<ImportReport> {
    const all = batch.rows ? normalize(batch.kind, batch.headers, batch.rows, batch.mapping) : [];
    const valid = all.filter((r) => r.data);
    const location = batch.locationId
      ? ((await this.db.tx.select({ name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.id, batch.locationId)))[0]?.name ?? null)
      : null;
    const base = {
      id: batch.id,
      kind: batch.kind,
      fileName: batch.fileName,
      committedAt: batch.committedAt,
      location,
      rows: all.length,
      skippedRows: all.length - valid.length,
      fileKept: Boolean(batch.rows),
    };
    if (!batch.rows) return { ...base, checks: [], differences: [], differenceCount: 0 };
    const rows = valid.map((r) => ({ line: r.line, data: r.data! }));
    const run = {
      products: () => this.products(batch, rows as { line: number; data: ProductRow }[]),
      customers: () => this.customers(rows as { line: number; data: CustomerRow }[]),
      suppliers: () => this.suppliers(rows as { line: number; data: SupplierRow }[]),
      gift_cards: () => this.giftCards(rows as { line: number; data: GiftCardRow }[]),
      loyalty: () => this.loyalty(rows as { line: number; data: LoyaltyRow }[]),
      sales: () => this.sales(batch, rows as { line: number; data: SaleHistoryRow }[]),
    }[batch.kind];
    const { checks, differences } = await run();
    return { ...base, checks, differences: differences.slice(0, MAX_DIFFERENCES), differenceCount: differences.length };
  }

  private async products(batch: Batch, rows: { line: number; data: ProductRow }[]) {
    // A later row for the same item replaced an earlier one when importing, so the last one counts.
    const unique = new Map<string, { line: number; data: ProductRow }>();
    for (const r of rows) unique.set(r.data.sku?.toLowerCase() ?? r.data.barcodes[0] ?? `${r.data.name}|${r.data.variant}`.toLowerCase(), r);
    const items = [...unique.values()];
    const { bySku, byBarcode } = await this.imports.existingVariants(items.map((r) => r.data));
    const match = new Map(
      items.map((r) => [r, (r.data.sku && bySku.get(r.data.sku.toLowerCase())) || r.data.barcodes.map((c) => byBarcode.get(c)).find(Boolean) || null]),
    );
    const ids = [...new Set([...match.values()].flatMap((m) => (m ? [m.id] : [])))];
    const v = schema.productVariants;
    const details = new Map<string, { priceMinor: number; costMinor: number | null; active: boolean; onHand: number }>();
    for (let i = 0; i < ids.length; i += 1000) {
      const found = await this.db.tx
        .select({
          id: v.id,
          priceMinor: v.priceMinor,
          costMinor: v.costMinor,
          active: sql<boolean>`${v.status} = 'active' and ${schema.products.status} = 'active'`,
          onHand: batch.locationId
            ? sql<number>`coalesce((select on_hand from stock_levels s where s.variant_id = ${v.id} and s.location_id = ${batch.locationId}), 0)`.mapWith(
                Number,
              )
            : sql<number>`0`.mapWith(Number),
        })
        .from(v)
        .innerJoin(schema.products, eq(schema.products.id, v.productId))
        .where(inArray(v.id, ids.slice(i, i + 1000)));
      for (const f of found) details.set(f.id, f);
    }

    const differences: Difference[] = [];
    let found = 0;
    const totals = { fileUnits: 0, ampleUnits: 0, fileCost: 0, ampleCost: 0, fileRetail: 0, ampleRetail: 0 };
    for (const r of items) {
      const d = r.data;
      const label = `${d.sku ? `${d.sku} · ` : ''}${d.name}${d.variant && d.variant !== 'Default' ? ` (${d.variant})` : ''}`;
      const m = match.get(r);
      const a = m ? details.get(m.id) : undefined;
      if (!a || !a.active) {
        differences.push({ line: r.line, item: label, problem: a ? 'Archived in Ample POS' : 'Not in Ample POS', file: money(d.priceMinor), ample: null });
      } else {
        found++;
        if (a.priceMinor !== d.priceMinor)
          differences.push({ line: r.line, item: label, problem: 'Price', file: money(d.priceMinor), ample: money(a.priceMinor) });
        if (d.costMinor !== null && a.costMinor !== d.costMinor)
          differences.push({ line: r.line, item: label, problem: 'Cost', file: money(d.costMinor), ample: a.costMinor === null ? null : money(a.costMinor) });
      }
      if (batch.locationId && d.onHand !== null) {
        const ampleQty = a?.active ? a.onHand : 0;
        totals.fileUnits += d.onHand;
        totals.ampleUnits += ampleQty;
        totals.fileCost += d.onHand * (d.costMinor ?? 0);
        totals.ampleCost += ampleQty * (a?.costMinor ?? 0);
        totals.fileRetail += d.onHand * d.priceMinor;
        totals.ampleRetail += ampleQty * (a?.priceMinor ?? 0);
        if (a?.active && ampleQty !== d.onHand)
          differences.push({ line: r.line, item: label, problem: 'On hand', file: String(d.onHand), ample: String(ampleQty) });
      }
    }
    const checks = [check('items', 'Items', 'count', items.length, found)];
    if (batch.locationId) {
      const since = 'Sales and receiving since the import change stock, so check soon after importing.';
      checks.push(
        check('units', 'Units on hand', 'units', totals.fileUnits, totals.ampleUnits, since),
        check('cost_value', 'Inventory value at cost', 'money', totals.fileCost, totals.ampleCost),
        check('retail_value', 'Inventory value at retail', 'money', totals.fileRetail, totals.ampleRetail),
      );
    }
    return { checks, differences };
  }

  private async customers(rows: { line: number; data: CustomerRow }[]) {
    const find = await this.imports.customerFinder(rows.map((r) => r.data));
    const differences = rows
      .filter((r) => !find(r.data))
      .map((r) => ({ line: r.line, item: r.data.name, problem: 'Not in Ample POS', file: r.data.email ?? r.data.phone, ample: null }));
    return { checks: [check('customers', 'Customers', 'count', rows.length, rows.length - differences.length)], differences };
  }

  private async suppliers(rows: { line: number; data: SupplierRow }[]) {
    const existing = await this.imports.existingSuppliers(rows.map((r) => r.data));
    const names = new Set(rows.map((r) => r.data.name.toLowerCase()));
    const differences = rows
      .filter((r) => !existing.has(r.data.name.toLowerCase()))
      .map((r) => ({ line: r.line, item: r.data.name, problem: 'Not in Ample POS', file: r.data.name, ample: null }));
    return { checks: [check('suppliers', 'Suppliers', 'count', names.size, [...names].filter((n) => existing.has(n)).length)], differences };
  }

  private async giftCards(rows: { line: number; data: GiftCardRow }[]) {
    const unique = new Map(rows.map((r) => [r.data.code, r]));
    const cards = await this.imports.existingGiftCards([...unique.keys()]);
    const ids = [...cards.values()].map((c) => c.id);
    const balances = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 1000) {
      const e = schema.giftCardEntries;
      for (const r of await this.db.tx
        .select({ id: e.giftCardId, balance: sql<number>`sum(${e.amountMinor})`.mapWith(Number) })
        .from(e)
        .where(inArray(e.giftCardId, ids.slice(i, i + 1000)))
        .groupBy(e.giftCardId))
        balances.set(r.id, r.balance);
    }
    const differences: Difference[] = [];
    let found = 0;
    let fileTotal = 0;
    let ampleTotal = 0;
    for (const r of unique.values()) {
      const card = cards.get(r.data.code);
      const label = `•••• ${r.data.code.slice(-4)}`;
      fileTotal += r.data.balanceMinor;
      if (!card || card.status === 'void') {
        differences.push({
          line: r.line,
          item: label,
          problem: card ? 'Voided in Ample POS' : 'Not in Ample POS',
          file: money(r.data.balanceMinor),
          ample: null,
        });
        continue;
      }
      found++;
      const balance = balances.get(card.id) ?? 0;
      ampleTotal += balance;
      if (balance !== r.data.balanceMinor)
        differences.push({ line: r.line, item: label, problem: 'Balance', file: money(r.data.balanceMinor), ample: money(balance) });
    }
    return {
      checks: [
        check('cards', 'Gift cards', 'count', unique.size, found),
        check('balance', 'Gift card balances owed', 'money', fileTotal, ampleTotal, 'Cards spent since the import show as differences.'),
      ],
      differences,
    };
  }

  private async loyalty(rows: { line: number; data: LoyaltyRow }[]) {
    const find = await this.imports.customerFinder(rows.map((r) => r.data));
    const matched = rows.map((r) => ({ r, c: find(r.data) }));
    const ids = [...new Set(matched.flatMap((m) => (m.c ? [m.c.id] : [])))];
    const points = new Map<string, number>();
    const e = schema.loyaltyEntries;
    for (let i = 0; i < ids.length; i += 1000) {
      for (const p of await this.db.tx
        .select({ id: e.customerId, points: sql<number>`sum(${e.points})`.mapWith(Number) })
        .from(e)
        .where(inArray(e.customerId, ids.slice(i, i + 1000)))
        .groupBy(e.customerId))
        points.set(p.id, p.points);
    }
    const differences: Difference[] = [];
    let fileTotal = 0;
    let ampleTotal = 0;
    for (const { r, c } of matched) {
      fileTotal += r.data.points;
      const label = c?.name ?? r.data.name ?? r.data.email ?? r.data.phone ?? '';
      if (!c) {
        differences.push({ line: r.line, item: label, problem: 'No matching customer', file: String(r.data.points), ample: null });
        continue;
      }
      const balance = points.get(c.id) ?? 0;
      ampleTotal += balance;
      if (balance !== r.data.points) differences.push({ line: r.line, item: label, problem: 'Points', file: String(r.data.points), ample: String(balance) });
    }
    return {
      checks: [
        check('customers', 'Customers with points', 'count', rows.length, matched.filter((m) => m.c).length),
        check('points', 'Points owed', 'points', fileTotal, ampleTotal, 'Points earned or spent since the import show as differences.'),
      ],
      differences,
    };
  }

  private async sales(batch: Batch, rows: { line: number; data: SaleHistoryRow }[]) {
    const h = schema.salesHistory;
    const [ample] = await this.db.tx
      .select({
        lines: sql<number>`count(*)`.mapWith(Number),
        receipts: sql<number>`count(distinct coalesce(${h.receipt}, ${h.id}::text))`.mapWith(Number),
        total: sql<number>`coalesce(sum(${h.totalMinor} + ${h.taxMinor}), 0)`.mapWith(Number),
        tax: sql<number>`coalesce(sum(${h.taxMinor}), 0)`.mapWith(Number),
      })
      .from(h)
      .where(and(eq(h.batchId, batch.id)));
    const receipts = new Set(rows.map((r, i) => r.data.receipt ?? `line-${i}`)).size;
    const total = rows.reduce((t, r) => t + r.data.totalMinor + r.data.taxMinor, 0);
    const tax = rows.reduce((t, r) => t + r.data.taxMinor, 0);
    const days = rows.map((r) => r.data.soldOn).sort();
    return {
      checks: [
        check('lines', 'Sales lines', 'count', rows.length, ample?.lines ?? 0, days.length ? `${days[0]} to ${days[days.length - 1]}` : undefined),
        check('receipts', 'Receipts', 'count', receipts, ample?.receipts ?? 0),
        check('total', 'Sales including tax', 'money', total, ample?.total ?? 0),
        check('tax', 'Tax', 'money', tax, ample?.tax ?? 0),
      ],
      differences: [] as Difference[],
    };
  }
}

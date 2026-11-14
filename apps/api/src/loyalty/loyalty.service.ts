import { Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { currentTenant, currentUserId } from '../core/request-context';
import { pointsFor } from '../sales/pricing';

export interface Program {
  pointsPerDollar: number;
  rewardPoints: number;
  rewardValueMinor: number;
}

export const DEFAULT_PROGRAM: Program = { pointsPerDollar: 1, rewardPoints: 100, rewardValueMinor: 500 };

type Sale = typeof schema.sales.$inferSelect;

/**
 * The points ledger. A customer's balance is the sum of their entries; "earn"
 * entries for a sale are kept equal to what the sale earns now, so callers
 * just ask to sync after anything that could change it.
 */
@Injectable()
export class LoyaltyService {
  constructor(private readonly db: Db) {}

  async enabled(): Promise<boolean> {
    const [row] = await this.db.tx
      .select({ enabled: schema.tenantModules.enabled })
      .from(schema.tenantModules)
      .where(eq(schema.tenantModules.moduleId, 'loyalty'));
    return row?.enabled ?? false;
  }

  async program(): Promise<Program> {
    const [row] = await this.db.tx
      .select({ pointsPerDollar: schema.loyaltyPrograms.pointsPerDollar, rewardPoints: schema.loyaltyPrograms.rewardPoints, rewardValueMinor: schema.loyaltyPrograms.rewardValueMinor })
      .from(schema.loyaltyPrograms);
    return row ?? DEFAULT_PROGRAM;
  }

  async saveProgram(program: Program): Promise<Program> {
    const [row] = await this.db.tx
      .insert(schema.loyaltyPrograms)
      .values({ tenantId: currentTenant().tenantId, ...program })
      .onConflictDoUpdate({ target: schema.loyaltyPrograms.tenantId, set: { ...program, updatedAt: new Date() } })
      .returning();
    return { pointsPerDollar: row!.pointsPerDollar, rewardPoints: row!.rewardPoints, rewardValueMinor: row!.rewardValueMinor };
  }

  /** Locks the customer so two registers can't spend the same points at once. */
  async lockCustomer(customerId: string): Promise<boolean> {
    const [row] = await this.db.tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, customerId)).for('update');
    return Boolean(row);
  }

  async balance(customerId: string): Promise<number> {
    const [row] = await this.db.tx
      .select({ points: sql<number>`coalesce(sum(${schema.loyaltyEntries.points}), 0)`.mapWith(Number) })
      .from(schema.loyaltyEntries)
      .where(eq(schema.loyaltyEntries.customerId, customerId));
    return row?.points ?? 0;
  }

  async entries(customerId: string, limit = 100) {
    const e = schema.loyaltyEntries;
    return this.db.tx
      .select({ id: e.id, kind: e.kind, points: e.points, note: e.note, saleId: e.saleId, receiptNumber: schema.sales.receiptNumber, createdAt: e.createdAt })
      .from(e)
      .leftJoin(schema.sales, eq(schema.sales.id, e.saleId))
      .where(eq(e.customerId, customerId))
      .orderBy(desc(e.createdAt), desc(e.id))
      .limit(limit);
  }

  /** Points a sale's customer has earned on it so far (net of any taken back). */
  async earnedOnSale(saleId: string, customerId: string): Promise<number> {
    const [row] = await this.db.tx
      .select({ points: sql<number>`coalesce(sum(${schema.loyaltyEntries.points}), 0)`.mapWith(Number) })
      .from(schema.loyaltyEntries)
      .where(and(eq(schema.loyaltyEntries.saleId, saleId), eq(schema.loyaltyEntries.customerId, customerId), eq(schema.loyaltyEntries.kind, 'earn')));
    return row?.points ?? 0;
  }

  async record(entry: { customerId: string; saleId?: string | null; kind: 'earn' | 'redeem' | 'adjust'; points: number; note?: string | null }) {
    if (entry.points === 0) return;
    await this.db.tx.insert(schema.loyaltyEntries).values({
      tenantId: currentTenant().tenantId,
      customerId: entry.customerId,
      saleId: entry.saleId ?? null,
      kind: entry.kind,
      points: entry.points,
      note: entry.note ?? null,
      createdBy: currentUserId(),
    });
  }

  /**
   * Brings a sale's earned points in line with the sale as it is now: a
   * completed sale earns for its customer on what was paid before tax, less
   * what has been refunded; anyone else who earned on it gives those back.
   * Does nothing while the tool is off, so turning it off freezes balances.
   */
  async syncEarned(sale: Sale, refundedMinor: number) {
    if (!(await this.enabled())) return;
    const program = await this.program();
    const desired = new Map<string, number>();
    if (sale.status === 'completed' && sale.customerId && sale.totalMinor > 0) {
      const preTax = sale.totalMinor - sale.taxMinor;
      const kept = Math.max(0, sale.totalMinor - refundedMinor);
      const base = Number((BigInt(preTax) * BigInt(kept)) / BigInt(sale.totalMinor));
      desired.set(sale.customerId, pointsFor(base, program.pointsPerDollar));
    }
    const e = schema.loyaltyEntries;
    const current = await this.db.tx
      .select({ customerId: e.customerId, points: sql<number>`sum(${e.points})`.mapWith(Number) })
      .from(e)
      .where(and(eq(e.saleId, sale.id), eq(e.kind, 'earn')))
      .groupBy(e.customerId);
    const have = new Map(current.map((c) => [c.customerId, c.points]));
    for (const customerId of new Set([...desired.keys(), ...have.keys()])) {
      const delta = (desired.get(customerId) ?? 0) - (have.get(customerId) ?? 0);
      if (delta !== 0) await this.record({ customerId, saleId: sale.id, kind: 'earn', points: delta });
    }
  }
}

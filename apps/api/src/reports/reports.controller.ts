import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { ZodPipe } from '../core/zod';
import { buildShifts, localDate, type Punch } from '../workforce/timecards';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const rangeQuery = z
  .object({ from: isoDate, to: isoDate, locationId: z.string().uuid().optional() })
  .refine((q) => q.from <= q.to, 'from must be on or before to')
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, 'choose at most a year');
const locationQuery = z.object({ locationId: z.string().uuid().optional() });

const n = (v: unknown) => Number(v ?? 0);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Reports across the tools a business uses. Days are each location's own
 * calendar days, so a sale at 11pm in Chicago counts on that Chicago day.
 */
@Controller('reports')
@RequireModule('reporting')
@RequirePermission('reports.read')
export class ReportsController {
  constructor(private readonly db: Db) {}

  /** Sales by day: gross, discounts, tax, refunds and net, plus totals by payment method. */
  @Get('sales')
  async sales(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    const loc = q.locationId ? sql`and s.location_id = ${q.locationId}` : sql``;
    const days = await this.db.tx.execute<{ day: string; sales: string; gross: string; discount: string; tax: string }>(sql`
      select (s.completed_at at time zone l.timezone)::date::text as day,
             count(*) as sales, sum(s.total_minor) as gross, sum(s.discount_minor) as discount, sum(s.tax_minor) as tax
      from sales s join locations l on l.id = s.location_id
      where s.status = 'completed' ${loc}
        and (s.completed_at at time zone l.timezone)::date between ${q.from}::date and ${q.to}::date
      group by 1 order by 1`);
    const refunds = await this.db.tx.execute<{ day: string; refunds: string }>(sql`
      select (r.created_at at time zone l.timezone)::date::text as day, sum(r.amount_minor) as refunds
      from refunds r join sales s on s.id = r.sale_id join locations l on l.id = s.location_id
      where (r.created_at at time zone l.timezone)::date between ${q.from}::date and ${q.to}::date ${loc}
      group by 1`);
    const tenders = await this.db.tx.execute<{ method: string; amount: string }>(sql`
      select p.method, sum(p.amount_minor) as amount
      from payments p join sales s on s.id = p.sale_id join locations l on l.id = s.location_id
      where p.status = 'succeeded' and s.status = 'completed' ${loc}
        and (s.completed_at at time zone l.timezone)::date between ${q.from}::date and ${q.to}::date
      group by 1`);
    const top = await this.db.tx.execute<{ variant_id: string; description: string; quantity: string; revenue: string }>(sql`
      select sl.variant_id, min(sl.description) as description, sum(sl.quantity) as quantity, sum(sl.total_minor) as revenue
      from sale_lines sl join sales s on s.id = sl.sale_id join locations l on l.id = s.location_id
      where s.status = 'completed' ${loc}
        and (s.completed_at at time zone l.timezone)::date between ${q.from}::date and ${q.to}::date
      group by sl.variant_id order by sum(sl.total_minor) desc limit 10`);

    const refundByDay = new Map(refunds.map((r) => [r.day, n(r.refunds)]));
    const allDays = [...new Set([...days.map((d) => d.day), ...refundByDay.keys()])].sort();
    const rows = allDays.map((day) => {
      const d = days.find((x) => x.day === day);
      const gross = n(d?.gross);
      const refundsMinor = refundByDay.get(day) ?? 0;
      return { date: day, salesCount: n(d?.sales), grossMinor: gross, discountMinor: n(d?.discount), taxMinor: n(d?.tax), refundsMinor, netMinor: gross - refundsMinor };
    });
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((t, r) => t + (r[k] as number), 0);
    return {
      from: q.from,
      to: q.to,
      days: rows,
      totals: { salesCount: sum('salesCount'), grossMinor: sum('grossMinor'), discountMinor: sum('discountMinor'), taxMinor: sum('taxMinor'), refundsMinor: sum('refundsMinor'), netMinor: sum('netMinor') },
      tenders: Object.fromEntries(tenders.map((t) => [t.method, n(t.amount)])),
      topProducts: top.map((t) => ({ variantId: t.variant_id, description: t.description, quantity: n(t.quantity), revenueMinor: n(t.revenue) })),
    };
  }

  /** The daily sales table as CSV, for spreadsheets and accountants. */
  @Get('sales.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async salesCsv(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>, @Res({ passthrough: true }) res: Response) {
    const report = await this.sales(q);
    res.setHeader('Content-Disposition', `attachment; filename="sales-${q.from}-to-${q.to}.csv"`);
    const money = (minor: number) => (minor / 100).toFixed(2);
    const lines = [
      'date,sales,gross,discounts,tax,refunds,net',
      ...report.days.map((d) => [d.date, d.salesCount, money(d.grossMinor), money(d.discountMinor), money(d.taxMinor), money(d.refundsMinor), money(d.netMinor)].join(',')),
    ];
    return `${lines.join('\n')}\n`;
  }

  /** Stock on hand valued at cost, per location. Items without a cost are counted but not valued. */
  @Get('inventory')
  async inventory(@Query(new ZodPipe(locationQuery)) q: z.infer<typeof locationQuery>) {
    const rows = await this.db.tx.execute<{ location_id: string; location: string; units: string; value: string; uncosted_units: string; skus: string }>(sql`
      select l.id as location_id, l.name as location,
             coalesce(sum(greatest(sl.on_hand, 0)), 0) as units,
             coalesce(sum(greatest(sl.on_hand, 0) * v.cost_minor) filter (where v.cost_minor is not null), 0) as value,
             coalesce(sum(greatest(sl.on_hand, 0)) filter (where v.cost_minor is null), 0) as uncosted_units,
             count(*) filter (where sl.on_hand > 0) as skus
      from locations l
      left join stock_levels sl on sl.location_id = l.id
      left join product_variants v on v.id = sl.variant_id
      where l.archived_at is null ${q.locationId ? sql`and l.id = ${q.locationId}` : sql``}
      group by l.id, l.name order by l.name`);
    return rows.map((r) => ({ locationId: r.location_id, location: r.location, units: n(r.units), valueMinor: n(r.value), uncostedUnits: n(r.uncosted_units), itemsInStock: n(r.skus) }));
  }

  /** Hours worked per person (and scheduled, if Scheduling is on), with sales per labor hour. */
  @Get('labor')
  async labor(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    const from = new Date(`${addDays(q.from, -1)}T00:00:00Z`);
    const to = new Date(`${addDays(q.to, 2)}T00:00:00Z`);
    const rows = await this.db.tx
      .select({ punch: schema.timePunches, tz: schema.locations.timezone, name: sql<string>`coalesce(${schema.users.displayName}, ${schema.users.email})` })
      .from(schema.timePunches)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.timePunches.locationId))
      .innerJoin(schema.users, eq(schema.users.id, schema.timePunches.userId))
      .where(
        and(
          isNull(schema.timePunches.voidedAt),
          gte(schema.timePunches.occurredAt, from),
          lt(schema.timePunches.occurredAt, to),
          q.locationId ? eq(schema.timePunches.locationId, q.locationId) : undefined,
        ),
      );
    const tz = new Map(rows.map((r) => [r.punch.locationId, r.tz]));
    const names = new Map(rows.map((r) => [r.punch.userId, r.name]));
    const byUser = new Map<string, Punch[]>();
    for (const r of rows) byUser.set(r.punch.userId, [...(byUser.get(r.punch.userId) ?? []), r.punch]);

    const people = [...byUser].map(([userId, punches]) => {
      const shifts = buildShifts(punches).filter((s) => {
        const d = localDate(s.start, tz.get(s.locationId) ?? 'UTC');
        return d >= q.from && d <= q.to;
      });
      return {
        userId,
        name: names.get(userId),
        workedMinutes: shifts.reduce((t, s) => t + s.workedMinutes, 0),
        shifts: shifts.length,
        issues: shifts.reduce((t, s) => t + s.issues.length, 0),
      };
    });
    const workedMinutes = people.reduce((t, p) => t + p.workedMinutes, 0);
    const sales = await this.sales(q);
    return {
      from: q.from,
      to: q.to,
      people: people.sort((a, b) => b.workedMinutes - a.workedMinutes),
      workedMinutes,
      netSalesMinor: sales.totals.netMinor,
      // Net sales per hour worked; null when nobody clocked any time.
      salesPerLaborHourMinor: workedMinutes ? Math.round(sales.totals.netMinor / (workedMinutes / 60)) : null,
    };
  }
}

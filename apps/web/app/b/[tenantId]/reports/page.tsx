import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { addDays, formatDay, formatMinutes, localDate } from '@/lib/time';
import type { CurrentTenant, Location } from '@/lib/types';

interface SalesReport {
  days: { date: string; salesCount: number; grossMinor: number; discountMinor: number; taxMinor: number; refundsMinor: number; netMinor: number }[];
  totals: { salesCount: number; grossMinor: number; taxMinor: number; refundsMinor: number; netMinor: number };
  tenders: Record<string, number>;
  topProducts: { variantId: string; description: string; quantity: number; revenueMinor: number }[];
}
interface Valuation {
  locationId: string;
  location: string;
  units: number;
  valueMinor: number;
  uncostedUnits: number;
}
interface Labor {
  people: { userId: string; name: string; workedMinutes: number; issues: number }[];
  workedMinutes: number;
  salesPerLaborHourMinor: number | null;
}

const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ from?: string; to?: string; location?: string }>;
}) {
  const { tenantId } = await params;
  const sp = await searchParams;
  const [current, locations] = await Promise.all([api<CurrentTenant>('/tenant', { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const on = new Set(current.enabledModules);
  const today = localDate(new Date(), locations[0]?.timezone ?? 'UTC');
  const to = valid(sp.to) ?? today;
  const from = valid(sp.from) ?? addDays(to, -6);
  const loc = locations.find((l) => l.id === sp.location);
  const qs = `from=${from}&to=${to}${loc ? `&locationId=${loc.id}` : ''}`;
  const money = (n: number) => formatMoney(n, current.tenant.currency);

  const [sales, inventory, labor] = await Promise.all([
    on.has('pos') ? api<SalesReport>(`/reports/sales?${qs}`, { tenantId }) : null,
    on.has('inventory') ? api<Valuation[]>(`/reports/inventory${loc ? `?locationId=${loc.id}` : ''}`, { tenantId }) : null,
    on.has('time-clock') ? api<Labor>(`/reports/labor?${qs}`, { tenantId }) : null,
  ]);

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <form className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          From
          <input type="date" name="from" defaultValue={from} className="input mt-1" />
        </label>
        <label className="text-sm">
          To
          <input type="date" name="to" defaultValue={to} className="input mt-1" />
        </label>
        <select name="location" defaultValue={loc?.id ?? ''} className="input w-48">
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button className="btn-secondary">Update</button>
      </form>

      {sales && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Sales</h2>
            <a href={`/b/${tenantId}/reports/sales.csv?${qs}`} className="text-sm text-stone-600 hover:underline">
              Download CSV
            </a>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Net sales" value={money(sales.totals.netMinor)} />
            <Stat label="Sales" value={String(sales.totals.salesCount)} />
            <Stat label="Refunds" value={money(sales.totals.refundsMinor)} />
            <Stat label="Tax collected" value={money(sales.totals.taxMinor)} />
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-stone-500">
                <tr>
                  <th className="pb-2">Day</th>
                  <th className="pb-2 text-right">Sales</th>
                  <th className="pb-2 text-right">Gross</th>
                  <th className="pb-2 text-right">Refunds</th>
                  <th className="pb-2 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {sales.days.map((d) => (
                  <tr key={d.date} className="border-t border-stone-100">
                    <td className="py-1.5">{formatDay(d.date)}</td>
                    <td className="text-right tabular-nums">{d.salesCount}</td>
                    <td className="text-right tabular-nums">{money(d.grossMinor)}</td>
                    <td className="text-right tabular-nums">{d.refundsMinor ? `−${money(d.refundsMinor)}` : '—'}</td>
                    <td className="text-right font-medium tabular-nums">{money(d.netMinor)}</td>
                  </tr>
                ))}
                {sales.days.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-stone-500">
                      No sales in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="card text-sm">
              <h3 className="mb-2 font-medium">By payment method</h3>
              {Object.entries(sales.tenders).map(([method, amount]) => (
                <div key={method} className="flex justify-between capitalize">
                  <span>{method}</span>
                  <span className="tabular-nums">{money(amount)}</span>
                </div>
              ))}
              {Object.keys(sales.tenders).length === 0 && <p className="text-stone-500">—</p>}
            </div>
            <div className="card text-sm">
              <h3 className="mb-2 font-medium">Best sellers</h3>
              {sales.topProducts.map((p) => (
                <div key={p.variantId} className="flex justify-between gap-2">
                  <span>
                    {p.description} <span className="text-stone-400">× {p.quantity}</span>
                  </span>
                  <span className="tabular-nums">{money(p.revenueMinor)}</span>
                </div>
              ))}
              {sales.topProducts.length === 0 && <p className="text-stone-500">—</p>}
            </div>
          </div>
        </section>
      )}

      {labor && (
        <section className="space-y-3">
          <h2 className="font-medium">Labor</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Hours worked" value={formatMinutes(labor.workedMinutes)} />
            <Stat label="Net sales per labor hour" value={labor.salesPerLaborHourMinor === null ? '—' : money(labor.salesPerLaborHourMinor)} />
          </div>
          <ul className="card divide-y divide-stone-100 text-sm">
            {labor.people.map((p) => (
              <li key={p.userId} className="flex justify-between py-1.5">
                <span>
                  {p.name}
                  {p.issues > 0 && <span className="ml-2 text-xs text-red-700">{p.issues} timecard problems</span>}
                </span>
                <span className="tabular-nums">{formatMinutes(p.workedMinutes)}</span>
              </li>
            ))}
            {labor.people.length === 0 && <li className="py-1.5 text-stone-500">No time recorded.</li>}
          </ul>
        </section>
      )}

      {inventory && (
        <section className="space-y-3">
          <h2 className="font-medium">Stock value (at cost, now)</h2>
          <ul className="card divide-y divide-stone-100 text-sm">
            {inventory.map((v) => (
              <li key={v.locationId} className="flex justify-between py-1.5">
                <span>
                  {v.location} <span className="text-stone-400">· {v.units} units</span>
                  {v.uncostedUnits > 0 && <span className="ml-2 text-xs text-amber-700">{v.uncostedUnits} units have no cost set</span>}
                </span>
                <span className="font-medium tabular-nums">{money(v.valueMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!sales && !labor && !inventory && <p className="text-stone-600">Turn on Point of sale, Inventory or Time clock to see reports here.</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

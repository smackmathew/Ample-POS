import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import type { CurrentTenant, Location, RegisterSummary, SaleSummary } from '@/lib/types';
import { closeRegister, openRegister } from '../sales-actions';

const STATUS: Record<SaleSummary['status'], string> = {
  open: 'bg-sky-50 text-sky-800',
  completed: 'bg-teal-50 text-teal-800',
  voided: 'bg-stone-100 text-stone-500',
};

export default async function SalesPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ receipt?: string; closed?: string }>;
}) {
  const { tenantId } = await params;
  const { receipt, closed } = await searchParams;
  const closedSession =
    closed && /^[0-9a-f-]{36}$/i.test(closed) ? await api<RegisterSummary>(`/registers/sessions/${closed}`, { tenantId }).catch(() => null) : null;
  const qs = receipt && /^\d+$/.test(receipt) ? `?receipt=${receipt}` : '?limit=50';
  const [current, { session }, allLocations, { sales }] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<{ session: RegisterSummary | null }>('/registers/sessions/current', { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
    api<{ sales: SaleSummary[] }>(`/sales${qs}`, { tenantId }),
  ]);
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  const where = new Map(allLocations.map((l) => [l.id, l]));
  // Past rows can be at archived locations; only active ones can be picked.
  const locations = allLocations.filter((l) => !l.archivedAt);
  const tz = (locationId: string) => where.get(locationId)?.timezone || 'UTC';

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Sales</h1>

      {closedSession?.status === 'closed' && (
        <section className="card border-teal-200 bg-teal-50">
          <p className="font-medium">Register closed at {closedSession.locationName}</p>
          <p className="mt-1 text-sm">
            Expected {money(closedSession.totals.expectedCashMinor ?? 0)} · counted {money(closedSession.countedCashMinor ?? 0)} ·{' '}
            <span className={closedSession.varianceMinor && closedSession.varianceMinor < 0 ? 'font-semibold text-red-700' : 'font-semibold'}>
              {closedSession.varianceMinor === 0
                ? 'drawer balances'
                : `${(closedSession.varianceMinor ?? 0) < 0 ? 'short' : 'over'} ${money(Math.abs(closedSession.varianceMinor ?? 0))}`}
            </span>
          </p>
        </section>
      )}

      {session ? (
        <section className="card flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-medium">Register open at {session.locationName}</p>
            <p className="text-sm text-stone-500">
              {session.totals.salesCount} sales · {money(session.totals.grossMinor)} · cash expected in drawer {money(session.totals.expectedCashMinor ?? 0)}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <Link href={`/b/${tenantId}/sales/register`} className="btn">
              Go to register
            </Link>
            <ActionForm action={closeRegister.bind(null, tenantId, session.id)} className="flex flex-wrap gap-2">
              <input name="counted" inputMode="decimal" placeholder="Cash counted" required className="input w-36" />
              <button className="btn-secondary">Close register</button>
            </ActionForm>
          </div>
        </section>
      ) : locations.length ? (
        <ActionForm action={openRegister.bind(null, tenantId)} className="card flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Location
            <select name="locationId" className="input mt-1 w-48">
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Starting cash in drawer
            <input name="float" inputMode="decimal" placeholder="100.00" className="input mt-1 w-36" />
          </label>
          <button className="btn">Open register</button>
        </ActionForm>
      ) : (
        <p className="text-stone-600">
          Add a <Link href={`/b/${tenantId}/locations`} className="underline">location</Link> before opening a register.
        </p>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Recent sales</h2>
          <form className="flex gap-2">
            <input name="receipt" defaultValue={receipt ?? ''} placeholder="Receipt #" inputMode="numeric" className="input w-32" />
            <button className="btn-secondary">Find</button>
          </form>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Receipt</th>
                <th className="pb-2">When</th>
                <th className="pb-2">Location</th>
                <th className="pb-2">Cashier</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} className="border-t border-stone-100">
                  <td className="py-2">
                    <Link href={`/b/${tenantId}/sales/${s.id}`} className="font-medium hover:underline">
                      {s.receiptNumber ? `#${s.receiptNumber}` : 'View'}
                    </Link>
                  </td>
                  <td className="text-stone-500">{formatDateTime(s.createdAt, tz(s.locationId))}</td>
                  <td>{s.locationName}</td>
                  <td>{s.cashier ?? s.cashierEmail}</td>
                  <td>
                    <span className={`rounded px-2 py-0.5 text-xs capitalize ${STATUS[s.status]}`}>{s.status}</span>
                    {s.refundedMinor > 0 && <span className="ml-2 text-xs text-red-700">refunded {money(s.refundedMinor)}</span>}
                  </td>
                  <td className="text-right tabular-nums">{money(s.totalMinor)}</td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-stone-500">
                    No sales yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

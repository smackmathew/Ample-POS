import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { CurrentTenant, RegisterSummary } from '@/lib/types';

export default async function RegistersPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, sessions] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<RegisterSummary[]>('/registers/sessions?limit=100', { tenantId }),
  ]);
  const money = (n: number | null) => (n === null ? '—' : formatMoney(n, current.tenant.currency));

  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">Registers</h1>
      <p className="text-sm text-stone-600">Each row is one shift. Expected cash is the starting float plus cash sales minus cash refunds.</p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Opened</th>
              <th className="pb-2">Location</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Sales</th>
              <th className="pb-2 text-right">Card</th>
              <th className="pb-2 text-right">Cash</th>
              <th className="pb-2 text-right">Expected cash</th>
              <th className="pb-2 text-right">Counted</th>
              <th className="pb-2 text-right">Over / short</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-t border-stone-100">
                <td className="py-2 whitespace-nowrap">{new Date(s.openedAt).toLocaleString()}</td>
                <td>
                  {s.locationName}
                  {s.deviceId ? '' : <span className="ml-1 text-xs text-stone-400">(web)</span>}
                </td>
                <td className="capitalize">{s.status}</td>
                <td className="text-right tabular-nums">
                  {s.totals.salesCount} · {money(s.totals.grossMinor)}
                </td>
                <td className="text-right tabular-nums">{money(s.totals.cardMinor)}</td>
                <td className="text-right tabular-nums">{money(s.totals.cashMinor - s.totals.cashRefundsMinor)}</td>
                <td className="text-right tabular-nums">{money(s.totals.expectedCashMinor)}</td>
                <td className="text-right tabular-nums">{money(s.countedCashMinor)}</td>
                <td className={`text-right font-medium tabular-nums ${s.varianceMinor && s.varianceMinor < 0 ? 'text-red-700' : s.varianceMinor ? 'text-teal-700' : ''}`}>
                  {s.varianceMinor === null ? '—' : `${s.varianceMinor > 0 ? '+' : ''}${money(s.varianceMinor)}`}
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={9} className="py-4 text-stone-500">
                  No registers opened yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

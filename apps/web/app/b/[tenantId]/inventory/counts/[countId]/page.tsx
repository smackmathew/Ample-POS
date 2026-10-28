import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/time';
import { can, variantLabel, type CountDetail, type CountEntry, type CurrentTenant, type Location } from '@/lib/types';
import { countScan, countTransition, voidCountEntry } from '../../../catalog-actions';

export default async function CountPage({ params }: { params: Promise<{ tenantId: string; countId: string }> }) {
  const { tenantId, countId } = await params;
  const [current, count, entries, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<CountDetail>(`/inventory/counts/${countId}`, { tenantId }),
    api<CountEntry[]>(`/inventory/counts/${countId}/entries`, { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
  ]);
  const tz = locations.find((l) => l.id === count.locationId)?.timezone || 'UTC';
  const perms = current.membership.permissions;
  const canCount = can(perms, 'inventory.count');
  const canApprove = can(perms, 'inventory.count.approve');
  const step = (s: 'submit' | 'reopen' | 'approve' | 'cancel') => countTransition.bind(null, tenantId, countId, s);
  const isOpen = count.status === 'open';

  return (
    <div className="max-w-5xl space-y-6">
      <Link href={`/b/${tenantId}/inventory/counts`} className="text-sm text-stone-500 hover:underline">
        ← Counts
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {count.name} <span className="ml-2 align-middle text-sm font-normal text-stone-500 capitalize">{count.status}</span>
        </h1>
        <div className="flex gap-2">
          {canCount && isOpen && (
            <ActionForm action={step('submit')}>
              <button className="btn">Submit for approval</button>
            </ActionForm>
          )}
          {canCount && count.status === 'submitted' && (
            <ActionForm action={step('reopen')}>
              <button className="btn-secondary">Reopen</button>
            </ActionForm>
          )}
          {canApprove && count.status === 'submitted' && (
            <ActionForm action={step('approve')}>
              <button className="btn">Approve and adjust stock</button>
            </ActionForm>
          )}
          {canCount && (isOpen || count.status === 'submitted') && (
            <ActionForm action={step('cancel')}>
              <button className="btn-secondary">Cancel count</button>
            </ActionForm>
          )}
        </div>
      </div>

      {canCount && isOpen && (
        <ActionForm action={countScan.bind(null, tenantId, countId)} className="card flex flex-wrap items-start gap-2">
          <input name="code" placeholder="Scan or type barcode / SKU" autoFocus required className="input max-w-sm" />
          <input name="quantity" type="number" min={1} defaultValue={1} className="input w-24" />
          <button className="btn">Add</button>
        </ActionForm>
      )}

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Review</h2>
          <p className="text-sm text-stone-500">
            {count.totals.items} items · {count.totals.withDiscrepancy} with differences · net {count.totals.netUnits > 0 ? '+' : ''}
            {count.totals.netUnits} units
          </p>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          “Expected” is the stock record at the moment each item was counted, so sales during the count are not treated as losses.
        </p>
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Counted</th>
                <th className="pb-2 text-right">Expected</th>
                <th className="pb-2 text-right">Difference</th>
              </tr>
            </thead>
            <tbody>
              {count.lines.map((l) => (
                <tr key={l.variantId} className="border-t border-stone-100">
                  <td className="py-2">{variantLabel(l.productName, l.variantName)}</td>
                  <td className="text-right tabular-nums">{l.counted}</td>
                  <td className="text-right tabular-nums">{l.expected}</td>
                  <td className={`text-right font-medium tabular-nums ${l.discrepancy < 0 ? 'text-red-700' : l.discrepancy > 0 ? 'text-teal-700' : 'text-stone-400'}`}>
                    {l.discrepancy > 0 ? `+${l.discrepancy}` : l.discrepancy}
                  </td>
                </tr>
              ))}
              {count.lines.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-stone-500">Nothing counted yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-medium">Entries</h2>
        <ul className="card mt-2 divide-y divide-stone-100 text-sm">
          {entries.map((e) => (
            <li key={e.id} className={`flex items-center justify-between gap-3 py-2 ${e.voidedAt ? 'text-stone-400 line-through' : ''}`}>
              <span>
                {e.quantity} × {variantLabel(e.productName, e.variantName)}
              </span>
              <span className="flex items-center gap-3 text-xs text-stone-500">
                {e.countedBy?.displayName ?? e.countedBy?.email} · {formatTime(e.countedAt, tz)}
                {canCount && isOpen && !e.voidedAt && (
                  <form action={voidCountEntry.bind(null, tenantId, countId, e.id)}>
                    <button className="text-red-700 hover:underline">Void</button>
                  </form>
                )}
              </span>
            </li>
          ))}
          {entries.length === 0 && <li className="py-2 text-stone-500">No entries.</li>}
        </ul>
      </section>
    </div>
  );
}

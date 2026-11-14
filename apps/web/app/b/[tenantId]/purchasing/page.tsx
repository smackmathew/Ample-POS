import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDate, homeTimeZone } from '@/lib/time';
import { can, type CurrentTenant, type Location, type PurchaseOrderSummary, type Supplier } from '@/lib/types';
import { newOrder } from '../purchasing-actions';
import { StatusBadge } from './status';

const FILTERS = [
  ['open', 'Open'],
  ['received', 'Received'],
  ['canceled', 'Canceled'],
  ['', 'All'],
] as const;

export default async function PurchasingPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ status?: string }> }) {
  const { tenantId } = await params;
  const { status = 'open' } = await searchParams;
  const filter = FILTERS.some(([k]) => k === status) ? status : 'open';
  const [current, locations, suppliers, orders] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
    api<Supplier[]>('/suppliers', { tenantId }),
    api<PurchaseOrderSummary[]>(`/purchase-orders?limit=100${filter ? `&status=${filter}` : ''}`, { tenantId }),
  ]);
  const canManage = can(current.membership.permissions, 'purchasing.manage');
  const tz = homeTimeZone(locations);
  const money = (n: number) => formatMoney(n, current.tenant.currency);

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Purchase orders</h1>

      {canManage &&
        (suppliers.length && locations.length ? (
          <ActionForm action={newOrder.bind(null, tenantId)} className="card flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Supplier
              <select name="supplierId" className="input mt-1 w-56">
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Deliver to
              <select name="locationId" className="input mt-1 w-48">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn">New order</button>
          </ActionForm>
        ) : (
          <p className="card text-stone-600">
            {suppliers.length ? 'Add a location first.' : (
              <>
                Add a <Link href={`/b/${tenantId}/purchasing/suppliers`} className="underline">supplier</Link> to start an order.
              </>
            )}
          </p>
        ))}

      <section className="space-y-2">
        <nav className="flex gap-2 text-sm">
          {FILTERS.map(([key, label]) => (
            <Link
              key={key || 'all'}
              href={`/b/${tenantId}/purchasing?status=${key}`}
              className={`rounded px-3 py-1 ${filter === key ? 'bg-stone-900 text-white' : 'bg-white text-stone-700 hover:bg-stone-100'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Order</th>
                <th className="pb-2">Supplier</th>
                <th className="pb-2">Deliver to</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Expected</th>
                <th className="pb-2 text-right">Items</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-stone-100">
                  <td className="py-2">
                    <Link href={`/b/${tenantId}/purchasing/${o.id}`} className="font-medium hover:underline">
                      {o.reference}
                    </Link>
                    <div className="text-xs text-stone-500">{formatDate(o.orderedAt ?? o.createdAt, tz)}</div>
                  </td>
                  <td>{o.supplierName}</td>
                  <td>{o.locationName}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="text-stone-500">{o.expectedOn ?? '—'}</td>
                  <td className="text-right tabular-nums">{o.itemCount}</td>
                  <td className="text-right tabular-nums">{money(o.totalMinor)}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-stone-500">
                    No orders here.
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

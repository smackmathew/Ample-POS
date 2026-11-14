import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api, authConfig } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDate, formatDateTime, homeTimeZone } from '@/lib/time';
import { can, type CurrentTenant, type Location, type PurchaseOrder, type Supplier } from '@/lib/types';
import { receiveOrder } from '../../purchasing-actions';
import { StatusBadge } from '../status';
import { DraftEditor } from './draft-editor';
import { OrderActions } from './order-actions';

export default async function PurchaseOrderPage({ params }: { params: Promise<{ tenantId: string; orderId: string }> }) {
  const { tenantId, orderId } = await params;
  const [current, order, locations, auth] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<PurchaseOrder>(`/purchase-orders/${orderId}`, { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
    authConfig(),
  ]);
  const canManage = can(current.membership.permissions, 'purchasing.manage');
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  const tz = homeTimeZone(locations);
  const receiving = order.status === 'ordered' || order.status === 'partially_received';

  return (
    <div className="max-w-5xl space-y-6">
      <Link href={`/b/${tenantId}/purchasing`} className="text-sm text-stone-500 hover:underline">
        ← Purchase orders
      </Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {order.reference} · {order.supplier.name}
        </h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          <StatusBadge status={order.status} />
          <span>
            to {order.locationName}
            {order.orderedAt && ` · ordered ${formatDate(order.orderedAt, tz)}`}
            {order.expectedOn && ` · needed by ${order.expectedOn}`}
          </span>
        </div>
      </div>

      {order.status === 'draft' && canManage ? (
        <DraftEditor
          tenantId={tenantId}
          order={order}
          suppliers={await api<Supplier[]>('/suppliers', { tenantId })}
          locations={locations.filter((l) => !l.archivedAt)}
          currency={current.tenant.currency}
          canEmail={auth.emailEnabled}
        />
      ) : receiving ? (
        <ActionForm action={receiveOrder.bind(null, tenantId, order.id, randomUUID())} className="card space-y-3">
          <h2 className="font-medium">Receive a delivery</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Ordered</th>
                <th className="pb-2 text-right">Received</th>
                <th className="pb-2 text-right">In stock</th>
                <th className="pb-2 pl-4">Arrived now</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => {
                const left = Math.max(0, l.quantityOrdered - l.quantityReceived);
                return (
                  <tr key={l.id} className="border-t border-stone-100">
                    <td className="py-2">
                      {l.description}
                      <div className="text-xs text-stone-500">
                        {l.sku ? `${l.sku} · ` : ''}
                        {money(l.unitCostMinor)} each
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{l.quantityOrdered}</td>
                    <td className="text-right tabular-nums">{l.quantityReceived}</td>
                    <td className="text-right tabular-nums">{l.onHand}</td>
                    <td className="pl-4">
                      <input name={`qty:${l.id}`} inputMode="numeric" defaultValue={left || ''} placeholder="0" className="input w-24" aria-label={`Arrived now: ${l.description}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <input name="note" placeholder="Note, e.g. packing slip number (optional)" className="input" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="updateCosts" defaultChecked /> Update item costs to what this order paid
          </label>
          <button className="btn">Receive into stock</button>
        </ActionForm>
      ) : (
        <section className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Ordered</th>
                <th className="pb-2 text-right">Received</th>
                <th className="pb-2 text-right">Cost each</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id} className="border-t border-stone-100">
                  <td className="py-2">{l.description}</td>
                  <td className="text-right tabular-nums">{l.quantityOrdered}</td>
                  <td className="text-right tabular-nums">{l.quantityReceived}</td>
                  <td className="text-right tabular-nums">{money(l.unitCostMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-right font-medium">Total {money(order.totalMinor)}</p>
        </section>
      )}

      {canManage && order.status === 'partially_received' && <OrderActions tenantId={tenantId} orderId={order.id} action="close" />}
      {canManage && order.status === 'ordered' && <OrderActions tenantId={tenantId} orderId={order.id} action="cancel" />}

      {order.receipts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Deliveries</h2>
          <div className="card">
            <table className="w-full text-sm">
              <tbody>
                {order.receipts.map((r) => (
                  <tr key={r.id} className="border-t border-stone-100 first:border-0">
                    <td className="py-1.5 text-stone-500">{formatDateTime(r.createdAt, tz)}</td>
                    <td>
                      {r.units} units{r.receivedBy ? ` · ${r.receivedBy}` : ''}
                      {r.note && <span className="text-stone-500"> · {r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {order.status !== 'draft' && order.supplier.email && <p className="text-sm text-stone-500">Supplier email: {order.supplier.email}</p>}
    </div>
  );
}

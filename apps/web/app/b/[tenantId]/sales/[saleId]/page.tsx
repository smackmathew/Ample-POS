import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatPercent } from '@/lib/pricing';
import { formatDate, formatDateTime, zoneFinder } from '@/lib/time';
import { can, type CurrentTenant, type Location, type Sale } from '@/lib/types';
import { emailReceipt, refundSale } from '../../sales-actions';
import { SaleCustomer } from './sale-customer';

export default async function SalePage({ params }: { params: Promise<{ tenantId: string; saleId: string }> }) {
  const { tenantId, saleId } = await params;
  const [current, sale, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Sale>(`/sales/${saleId}`, { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
  ]);
  const tz = zoneFinder(locations)(sale.locationId);
  const money = (n: number) => formatMoney(n, sale.currency);
  const refundable = sale.lines.filter((l) => l.quantity > l.refundedQuantity);
  const customersOn = current.enabledModules.includes('customers') && can(current.membership.permissions, 'customers.use');
  const canRefund = sale.status === 'completed' && refundable.length > 0 && can(current.membership.permissions, 'pos.refund');

  return (
    <div className="max-w-3xl space-y-6">
      <Link href={`/b/${tenantId}/sales`} className="text-sm text-stone-500 hover:underline">
        ← Sales
      </Link>
      <div className="card space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">{sale.receiptNumber ? `Receipt #${sale.receiptNumber}` : 'Sale'}</h1>
          <span className="text-sm capitalize text-stone-500">
            {sale.status} · {formatDateTime(sale.completedAt ?? sale.createdAt, tz)}
          </span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.id} className="border-t border-stone-100 first:border-0">
                <td className="py-1.5">
                  {l.quantity} × {l.description}
                  {l.discountMinor - l.rewardMinor > 0 && <span className="ml-2 text-xs text-stone-500">−{money(l.discountMinor - l.rewardMinor)} discount</span>}
                  {l.refundedQuantity > 0 && <span className="ml-2 text-xs text-red-700">{l.refundedQuantity} refunded</span>}
                </td>
                <td className="text-right tabular-nums">{money(l.unitPriceMinor * l.quantity - (l.discountMinor - l.rewardMinor))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="space-y-1 border-t border-stone-200 pt-2 text-sm">
          <Line label="Subtotal" value={money(sale.subtotalMinor - sale.discountMinor + sale.rewardMinor)} />
          {sale.rewardMinor > 0 && <Line label={`Loyalty reward (${sale.rewardPoints} points)`} value={`−${money(sale.rewardMinor)}`} />}
          <Line label={`Tax (${formatPercent(sale.taxRateBps)})`} value={money(sale.taxMinor)} />
          <Line label="Total" value={money(sale.totalMinor)} strong />
          {sale.payments
            .filter((p) => p.status === 'succeeded')
            .map((p) => (
              <Line
                key={p.id}
                label={p.method === 'cash' ? `Cash — tendered ${money(p.tenderedMinor ?? 0)}, change ${money(p.changeMinor ?? 0)}` : 'Card'}
                value={money(p.amountMinor)}
              />
            ))}
          {sale.refunds.map((r) => (
            <Line key={r.id} label={`Refund ${formatDate(r.createdAt, tz)}${r.reason ? ` — ${r.reason}` : ''}`} value={`−${money(r.amountMinor)}`} />
          ))}
        </dl>
      </div>

      {customersOn ? (
        <section className="card space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">Customer</h2>
            {sale.customer && (
              <Link href={`/b/${tenantId}/customers/${sale.customer.id}`} className="text-sm text-stone-500 hover:underline">
                View history
              </Link>
            )}
          </div>
          <div className="max-w-sm">
            <SaleCustomer tenantId={tenantId} saleId={sale.id} customer={sale.customer} />
          </div>
          {sale.loyalty && sale.status === 'completed' && (
            <p className="text-sm text-stone-600">
              Earned {sale.loyalty.earnedPoints} points on this sale · balance {sale.loyalty.balance}
            </p>
          )}
        </section>
      ) : (
        sale.customer && <p className="text-sm text-stone-600">Customer: {sale.customer.name}</p>
      )}

      {sale.status !== 'open' && (
        <section className="card flex flex-wrap items-end gap-3">
          <a href={`/b/${tenantId}/sales/${sale.id}/receipt?print=1`} target="_blank" rel="noopener" className="btn-secondary">
            Print receipt
          </a>
          {sale.status === 'completed' && (
            <ActionForm action={emailReceipt.bind(null, tenantId, sale.id)} className="flex flex-1 flex-wrap items-center gap-2">
              <input
                key={sale.customer?.email ?? ''}
                name="email"
                type="email"
                placeholder="Customer’s email"
                defaultValue={sale.customer?.email ?? ''}
                required
                className="input min-w-48 flex-1"
              />
              <button className="btn-secondary">Email receipt</button>
            </ActionForm>
          )}
        </section>
      )}

      {canRefund && (
        <ActionForm action={refundSale.bind(null, tenantId, sale.id, randomUUID())} className="card space-y-3">
          <h2 className="font-medium">Refund items</h2>
          {refundable.map((l) => (
            <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{l.description}</span>
              <span className="flex items-center gap-2 text-stone-500">
                <input type="number" name={`qty:${l.id}`} min={0} max={l.quantity - l.refundedQuantity} defaultValue={0} className="input w-20" />
                of {l.quantity - l.refundedQuantity}
              </span>
            </label>
          ))}
          <input name="reason" placeholder="Reason (optional)" className="input" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="restock" defaultChecked /> Put items back in stock
          </label>
          <p className="text-xs text-stone-500">
            Card payments are refunded to the card. Cash is paid from your open register.
          </p>
          <button className="btn">Refund</button>
        </ActionForm>
      )}
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'text-base font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

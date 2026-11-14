import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDate, formatDateTime, homeTimeZone, zoneFinder } from '@/lib/time';
import { can, type CurrentTenant, type Customer, type CustomerPoints, type Location } from '@/lib/types';
import { adjustPoints } from '../../loyalty-actions';
import { deleteCustomer, updateCustomer } from '../../customer-actions';

export default async function CustomerPage({ params }: { params: Promise<{ tenantId: string; customerId: string }> }) {
  const { tenantId, customerId } = await params;
  const [current, customer, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Customer>(`/customers/${customerId}`, { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
  ]);
  const loyaltyOn = current.enabledModules.includes('loyalty');
  const points = loyaltyOn ? await api<CustomerPoints>(`/loyalty/customers/${customerId}`, { tenantId }) : null;
  const tz = homeTimeZone(locations);
  const zoneOf = zoneFinder(locations);
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  const canManage = can(current.membership.permissions, 'customers.manage');

  return (
    <div className="max-w-4xl space-y-6">
      <Link href={`/b/${tenantId}/customers`} className="text-sm text-stone-500 hover:underline">
        ← Customers
      </Link>
      <div className="card space-y-1">
        <h1 className="text-xl font-semibold">{customer.name}</h1>
        <p className="text-sm text-stone-600">{[customer.email, customer.phone].filter(Boolean).join(' · ') || 'No contact details'}</p>
        {customer.note && <p className="text-sm">{customer.note}</p>}
        <dl className="grid grid-cols-3 gap-4 pt-3 text-sm">
          <Stat label="Visits" value={String(customer.visits)} />
          <Stat label="Spent (after refunds)" value={money(customer.spentMinor)} />
          <Stat label="Last visit" value={customer.lastVisitAt ? formatDate(customer.lastVisitAt, tz) : '—'} />
        </dl>
      </div>

      {points && (
        <section className="space-y-2">
          <h2 className="font-medium">Loyalty points</h2>
          <div className="card space-y-3">
            <p>
              <span className="text-2xl font-semibold tabular-nums">{points.balance.toLocaleString('en-US')}</span> points
              <span className="ml-2 text-sm text-stone-500">
                {points.rewardsAvailable > 0
                  ? `${points.rewardsAvailable} reward${points.rewardsAvailable === 1 ? '' : 's'} of ${money(points.program.rewardValueMinor)} ready to use`
                  : `${points.program.rewardPoints - Math.max(0, points.balance)} more for ${money(points.program.rewardValueMinor)} off`}
              </span>
            </p>
            {points.entries.length > 0 && (
              <table className="w-full text-sm">
                <tbody>
                  {points.entries.map((e) => (
                    <tr key={e.id} className="border-t border-stone-100">
                      <td className="py-1.5 text-stone-500">{formatDate(e.createdAt, tz)}</td>
                      <td>
                        {e.kind === 'adjust' ? (
                          `Adjusted: ${e.note}`
                        ) : (
                          <>
                            {e.kind === 'earn' ? (e.points > 0 ? 'Earned on ' : 'Taken back on ') : e.points < 0 ? 'Reward used on ' : 'Reward returned on '}
                            {e.saleId ? (
                              <Link href={`/b/${tenantId}/sales/${e.saleId}`} className="hover:underline">
                                {e.receiptNumber ? `receipt #${e.receiptNumber}` : 'a sale'}
                              </Link>
                            ) : (
                              'a sale'
                            )}
                            {e.note && e.kind === 'redeem' && e.points > 0 && <span className="text-stone-500"> ({e.note.toLowerCase()})</span>}
                          </>
                        )}
                      </td>
                      <td className={`text-right tabular-nums ${e.points < 0 ? 'text-red-700' : 'text-teal-700'}`}>
                        {e.points > 0 ? '+' : ''}
                        {e.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {can(current.membership.permissions, 'loyalty.manage') && (
              <ActionForm action={adjustPoints.bind(null, tenantId, customer.id)} className="flex flex-wrap items-start gap-2 border-t border-stone-100 pt-3">
                <input name="points" inputMode="numeric" placeholder="Points (+ or −)" required className="input w-36" />
                <input name="note" placeholder="Reason, e.g. moved from paper card" required className="input min-w-48 flex-1" />
                <button className="btn-secondary">Adjust points</button>
              </ActionForm>
            )}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Purchases</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Receipt</th>
                <th className="pb-2">When</th>
                <th className="pb-2">Location</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {customer.sales.map((s) => (
                <tr key={s.id} className="border-t border-stone-100">
                  <td className="py-2">
                    <Link href={`/b/${tenantId}/sales/${s.id}`} className="font-medium hover:underline">
                      {s.receiptNumber ? `#${s.receiptNumber}` : 'View'}
                    </Link>
                    {s.status === 'voided' && <span className="ml-2 text-xs text-stone-500">voided</span>}
                  </td>
                  <td className="text-stone-500">{formatDateTime(s.completedAt ?? s.createdAt, zoneOf(s.locationId))}</td>
                  <td>{s.locationName}</td>
                  <td className="text-right tabular-nums">
                    {money(s.totalMinor)}
                    {s.refundedMinor > 0 && <span className="block text-xs text-red-700">refunded {money(s.refundedMinor)}</span>}
                  </td>
                </tr>
              ))}
              {customer.sales.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-stone-500">
                    No purchases yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {canManage && (
        <>
          <ActionForm key={`${customer.name}|${customer.email}|${customer.phone}|${customer.note}`} action={updateCustomer.bind(null, tenantId, customer.id)} className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-medium sm:col-span-2">Edit details</h2>
            <label className="text-sm">
              Name
              <input name="name" defaultValue={customer.name} required className="input mt-1" />
            </label>
            <label className="text-sm">
              Email
              <input name="email" type="email" defaultValue={customer.email ?? ''} className="input mt-1" />
            </label>
            <label className="text-sm">
              Phone
              <input name="phone" type="tel" defaultValue={customer.phone ?? ''} className="input mt-1" />
            </label>
            <label className="text-sm">
              Note
              <input name="note" defaultValue={customer.note ?? ''} className="input mt-1" />
            </label>
            <div>
              <button className="btn">Save</button>
            </div>
          </ActionForm>

          <ActionForm action={deleteCustomer.bind(null, tenantId, customer.id)} className="card space-y-2 border-red-200">
            <h2 className="font-medium">Delete customer</h2>
            <p className="text-sm text-stone-600">Removes their name and contact details for good. Their past sales stay in your records, without a customer.</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" /> Delete {customer.name}’s details
            </label>
            <button className="btn-secondary text-red-700">Delete</button>
          </ActionForm>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

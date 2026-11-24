import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { BillingSummary } from '@/lib/types';
import { chooseWebsite, choosePlan, openPortal, setCancel, startCheckout } from '../billing-actions';

const day = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

const STATUS: Record<string, string> = {
  active: 'Active',
  trialing: 'Active — free until your trial ends',
  past_due: 'Payment failed — retrying',
  unpaid: 'Unpaid',
  incomplete: 'Waiting for the first payment',
  paused: 'Paused',
};

export default async function BillingPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { tenantId } = await params;
  const { checkout } = await searchParams;
  // Back from Stripe Checkout: read the new subscription now rather than waiting for the webhook.
  const b =
    checkout === 'success'
      ? await api<BillingSummary>('/billing/refresh', { tenantId, method: 'POST' })
      : await api<BillingSummary>('/billing', { tenantId });
  const money = (minor: number) => formatMoney(minor, b.currency.toUpperCase());
  const sub = b.subscription;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Billing</h1>

      {checkout === 'success' && !sub && (
        <p className="rounded border border-stone-200 bg-white p-3 text-sm">Thanks! Stripe is still confirming your subscription; this page will update in a moment.</p>
      )}
      {checkout === 'canceled' && <p className="rounded border border-stone-200 bg-white p-3 text-sm">Checkout was canceled. Nothing was charged.</p>}

      <section className="card space-y-3">
        {sub ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">{STATUS[sub.status] ?? sub.status}</h2>
              {sub.currentPeriodEnd && (
                <span className="text-sm text-stone-600">
                  {sub.cancelAtPeriodEnd ? 'Ends' : sub.status === 'trialing' ? 'First charge' : 'Renews'} {day(sub.currentPeriodEnd)}
                </span>
              )}
            </div>
            {b.standing === 'past_due' && (
              <p className="text-sm text-red-700">Your last payment didn’t go through. Update your card to avoid interruption.</p>
            )}
            {sub.cancelAtPeriodEnd && (
              <p className="text-sm text-stone-600">Your subscription is canceled and won’t renew. Paid tools become read-only after it ends.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {b.canManageOnline && (
                <ActionForm action={openPortal.bind(null, tenantId)}>
                  <button className="btn">Invoices and payment method</button>
                </ActionForm>
              )}
              {sub.cancelAtPeriodEnd ? (
                <ActionForm action={setCancel.bind(null, tenantId, false)}>
                  <button className="btn-secondary">Keep my subscription</button>
                </ActionForm>
              ) : (
                <ActionForm action={setCancel.bind(null, tenantId, true)}>
                  <button className="btn-secondary">Cancel at period end</button>
                </ActionForm>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">
              {b.standing === 'trial' ? `Free trial — ${daysLeft(b.trialEndsAt)} days left` : 'Your free trial has ended'}
            </h2>
            <p className="text-sm text-stone-600">
              {b.standing === 'trial'
                ? `Everything is free until ${day(b.trialEndsAt)}. Subscribe any time; you won’t be charged before your trial ends.`
                : 'Your data is safe and you can still view it, but paid tools are read-only until you subscribe.'}
            </p>
            <ActionForm action={startCheckout.bind(null, tenantId)}>
              <button className="btn">{b.provider === 'stripe' ? 'Subscribe with card' : 'Subscribe (test mode)'}</button>
            </ActionForm>
            {b.provider === 'simulated' && <p className="text-xs text-stone-500">Billing is in test mode: no card is collected and nothing is charged.</p>}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Plan</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {b.plans.map((p) => {
            const current = p.id === b.plan.id;
            return (
              <div key={p.id} className={`card flex flex-col gap-1 ${current ? 'border-brand' : ''}`}>
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  {current && <span className="rounded bg-teal-50 px-2 py-0.5 text-xs text-brand">Your plan</span>}
                </div>
                <p className="text-2xl font-semibold">
                  {money(p.baseMinor)}
                  <span className="text-sm font-normal text-stone-500">/mo</span>
                </p>
                <p className="text-sm text-stone-600">
                  {p.registersPerLocation} register{p.registersPerLocation === 1 ? '' : 's'} per location · +{money(p.extraLocationMinor)}/mo per extra location
                </p>
                {!current && (
                  <ActionForm action={choosePlan.bind(null, tenantId, p.id)} className="mt-auto pt-2">
                    <button className="btn-secondary w-full">Switch to {p.name}</button>
                  </ActionForm>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-stone-500">Every plan includes the point of sale, product catalog, reports, customers and loyalty rewards.</p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Online store</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {b.websiteAddons.map((a) => {
            const current = b.website?.id === a.id;
            return (
              <div key={a.id} className={`card flex flex-col gap-1 ${current ? 'border-brand' : ''}`}>
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold">{a.name}</h3>
                  {current && <span className="rounded bg-teal-50 px-2 py-0.5 text-xs text-brand">Added</span>}
                </div>
                <p className="text-sm text-stone-600">{a.description}</p>
                <p className="text-sm">
                  <strong>{money(a.setupMinor)}</strong> one-time setup + {money(b.plans.find((p) => p.id === b.plan.id)!.websiteMaintenanceMinor)}/mo sync on {b.plan.name}
                </p>
                {current ? (
                  <p className="text-xs text-stone-500">
                    {b.website!.setupCharged ? 'Setup paid.' : sub ? 'Setup is on your next invoice.' : 'Setup is charged when you subscribe.'}
                  </p>
                ) : (
                  <ActionForm action={chooseWebsite.bind(null, tenantId, a.id)} className="mt-auto pt-2">
                    <button className="btn-secondary w-full">{b.website ? `Switch to ${a.name}` : `Add ${a.name}`}</button>
                  </ActionForm>
                )}
              </div>
            );
          })}
        </div>
        {b.website && (
          <ActionForm action={chooseWebsite.bind(null, tenantId, null)}>
            <button className="text-sm text-stone-600 hover:underline">Remove the online store</button>
          </ActionForm>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">{sub ? 'Your monthly bill' : 'What you’ll pay'}</h2>
          <Link href={`/b/${tenantId}/tools`} className="text-sm text-stone-600 hover:underline">
            Change tools
          </Link>
        </div>
        <table className="card mt-2 w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2 font-medium">Item</th>
              <th className="pb-2 text-right font-medium">Price</th>
              <th className="pb-2 text-right font-medium">Qty</th>
              <th className="pb-2 text-right font-medium">Monthly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {b.lines.map((l) => (
              <tr key={l.moduleId}>
                <td className="py-2">{l.name}</td>
                <td className="py-2 text-right">{money(l.unitMinor)}</td>
                <td className="py-2 text-right">{l.quantity}</td>
                <td className="py-2 text-right">{money(l.totalMinor)}</td>
              </tr>
            ))}
            {b.included.length > 0 && (
              <tr>
                <td className="py-2 text-stone-600" colSpan={3}>
                  Included: {b.included.join(', ')}
                </td>
                <td className="py-2 text-right text-stone-600">{money(0)}</td>
              </tr>
            )}
            {!b.lines.length && !b.included.length && (
              <tr>
                <td className="py-2 text-stone-600" colSpan={4}>
                  No tools are on yet.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-stone-200 font-semibold">
              <td className="pt-2" colSpan={3}>
                Total per month
              </td>
              <td className="pt-2 text-right">{money(b.monthlyTotalMinor)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-xs text-stone-500">
          Your plan covers your first location; each extra active location and each paid add-on tool (per location) is added. Changing plans or tools, or adding and archiving locations, updates your bill
          {sub ? ' automatically, with the difference prorated on your next invoice.' : '.'} Prices in US dollars, before any sales tax.
        </p>
      </section>
    </div>
  );
}

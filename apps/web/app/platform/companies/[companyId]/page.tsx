import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { METHOD, SEVERITY, STANDING, usd, utc, type ActivityEntry, type Company, type Transaction } from '@/lib/platform';
import {
  cardPaymentsOff,
  renameCompany,
  restoreCompany,
  setCompanyOwner,
  setCompanyPlan,
  setCompanyTrial,
  startSupportView,
  suspendCompany,
} from '../../actions';
import { ToolRow } from './tool-row';

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ before?: string }> }) {
  const { companyId } = await params;
  const { before } = await searchParams;
  const [c, { transactions, nextBefore }, { entries }] = await Promise.all([
    api<Company>(`/platform/companies/${companyId}`),
    api<{ transactions: Transaction[]; nextBefore: string | null }>(
      `/platform/companies/${companyId}/transactions?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
    api<{ entries: ActivityEntry[] }>(`/platform/activity?tenantId=${companyId}&limit=15`),
  ]);
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c.currency }).format(minor / 100);

  return (
    <div className="max-w-6xl space-y-6">
      <Link href="/platform/companies" className="text-sm text-stone-500 hover:underline">
        ← Companies
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <p className="text-sm text-stone-500">
            {c.slug} · joined {utc(c.createdAt, false)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {c.suspendedAt && <span className="rounded-full bg-red-50 px-2.5 py-1 text-sm font-medium text-red-700">Suspended</span>}
          {c.billing?.standing && <span className={`rounded px-2 py-1 text-sm ${STANDING[c.billing.standing][1]}`}>{STANDING[c.billing.standing][0]}</span>}
        </div>
      </div>

      {c.issues.length > 0 && (
        <section className="card space-y-2 border-red-200">
          <h2 className="font-medium">Issues</h2>
          {c.issues.map((i) => (
            <div key={i.key} className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className={`rounded px-2 py-0.5 text-xs ${SEVERITY[i.severity]}`}>{i.severity}</span>
              <span className="font-medium">{i.title}</span>
              {i.detail && <span className="text-stone-500">{i.detail}</span>}
              <span className="text-xs text-stone-400">since {utc(i.since)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales, 30 days" value={money(c.stats.gross30Minor)} note={`${c.stats.sales30} sales · ${money(c.stats.refunds30Minor)} refunded`} />
        <Stat label="Monthly bill" value={c.billing ? usd(c.billing.mrrMinor) : '—'} note={billingNote(c)} />
        <Stat label="Stores · devices" value={`${c.locations.filter((l) => !l.archivedAt).length} · ${c.stats.devices}`} note={`${c.members.length} people`} />
        <Stat
          label="Products · customers"
          value={`${c.stats.products} · ${c.stats.customers}`}
          note={
            Object.entries(c.stats.tenders30)
              .map(([m, a]) => `${METHOD[m] ?? m} ${money(a)}`)
              .join(' · ') || 'No payments in 30 days'
          }
        />
      </section>

      <section className="card space-y-3 border-violet-200">
        <div>
          <h2 className="font-medium">Support view</h2>
          <p className="text-sm text-stone-600">
            See the business exactly as its owner does (products, sales, customers, reports, settings), read-only, for an hour. The business sees the visit and
            your reason in its audit log.
          </p>
        </div>
        <ActionForm action={startSupportView.bind(null, c.id)} className="flex flex-wrap gap-2">
          <input name="reason" placeholder="Why you’re looking, e.g. owner asked about missing sales" required minLength={3} className="input max-w-md" />
          <button className="btn">Open as owner (read-only)</button>
        </ActionForm>
        {c.supportSessions.length > 0 && (
          <div className="space-y-1 border-t border-stone-100 pt-2 text-xs text-stone-500">
            {c.supportSessions.slice(0, 5).map((s) => (
              <p key={s.id}>
                {utc(s.startedAt)} · {s.email} · {s.reason}
                {s.live && <span className="ml-1 rounded bg-violet-100 px-1.5 py-0.5 text-violet-800">open now</span>}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <h2 className="font-medium">Business details</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <ActionForm action={renameCompany.bind(null, c.id)} className="space-y-2">
            <label className="block text-sm">
              Name
              <input name="name" defaultValue={c.name} required maxLength={100} className="input mt-1" />
            </label>
            <button className="btn-secondary">Rename</button>
          </ActionForm>
          {c.billing && (
            <ActionForm action={setCompanyTrial.bind(null, c.id)} className="space-y-2">
              <label className="block text-sm">
                Free trial ends
                <input name="trialEndsAt" type="date" defaultValue={c.billing.trialEndsAt.slice(0, 10)} required className="input mt-1" />
              </label>
              <button className="btn-secondary">Move trial end</button>
              <p className="text-xs text-stone-500">Only matters until they subscribe. Up to a year from today.</p>
            </ActionForm>
          )}
          <ActionForm action={setCompanyOwner.bind(null, c.id)} className="space-y-2">
            <label className="block text-sm">
              Owner
              <select name="userId" defaultValue={c.members.find((m) => m.roleKey === 'owner')?.id} className="input mt-1">
                {c.members
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.email} ({m.role})
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm">
              Current owners become
              <select name="previousOwnersBecome" defaultValue="manager" className="input mt-1">
                {c.roles
                  .filter((r) => r.key !== 'owner')
                  .map((r) => (
                    <option key={r.id} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                <option value="keep">Keep them as owners too</option>
              </select>
            </label>
            <button className="btn-secondary">Change owner</button>
            <p className="text-xs text-stone-500">The new owner must already be in the business. Ask the owner to invite them first.</p>
          </ActionForm>
        </div>
      </section>

      {c.billing && (
        <ActionForm action={setCompanyPlan.bind(null, c.id)} className="card flex flex-wrap items-end gap-3">
          <h2 className="w-full font-medium">Plan</h2>
          <label className="text-sm">
            Plan
            <select name="plan" defaultValue={c.billing.plan} className="input mt-1 w-40">
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label className="text-sm">
            Online store
            <select name="website" defaultValue={c.billing.websiteAddon ?? 'none'} className="input mt-1 w-48">
              <option value="none">None</option>
              <option value="sync">Website sync</option>
              <option value="simple">Online store</option>
              <option value="complex">Website + online store</option>
            </select>
          </label>
          <button className="btn-secondary">Save</button>
          <p className="w-full text-xs text-stone-500">
            {c.billing.websiteAddon
              ? c.billing.websiteSetupChargedAt
                ? 'Store setup paid (or given by support).'
                : 'Store setup fee still to be charged at checkout.'
              : ''}{' '}
            An online store added here carries no setup fee.
          </p>
        </ActionForm>
      )}

      <section className="card">
        <h2 className="font-medium">Tools</h2>
        <p className="text-sm text-stone-500">
          Changes take effect at once and show in the business’s audit log as made by Ample POS support. <em>Free</em> tools stay on without being billed;{' '}
          <em>blocked</em> tools are off and the business can’t turn them back on.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-1">Tool</th>
              <th className="pb-1">Price / store</th>
              <th className="pb-1">On</th>
              <th className="pb-1">Free here</th>
              <th className="pb-1">Blocked</th>
            </tr>
          </thead>
          <tbody>
            {c.tools.map((t) => (
              <ToolRow key={t.id} companyId={c.id} tool={t} price={t.monthlyPriceMinor ? `${usd(t.monthlyPriceMinor)}/mo` : 'Included'} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-2">
        <h2 className="font-medium">Card payments (merchant setup)</h2>
        {!c.merchant || c.merchant.mode === 'off' ? (
          <p className="text-sm text-stone-600">
            Not taking cards.
            {c.merchant?.connectAccountId && ` Built-in account ${c.merchant.connectAccountId} is kept for when they turn cards back on.`}
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <p>
              Setup: <strong>{c.merchant.mode === 'platform' ? 'Built-in (Stripe Express)' : 'Their own Stripe account'}</strong>
            </p>
            <p>
              Account: <code className="text-xs">{c.merchant.mode === 'platform' ? c.merchant.connectAccountId : c.merchant.ownAccountId}</code>
              {c.merchant.livemode === false && <span className="ml-1 text-xs text-amber-700">test mode</span>}
            </p>
            <p>Taking cards: {c.merchant.chargesEnabled ? 'yes' : <strong className="text-red-700">no</strong>}</p>
            <p>Payouts: {c.merchant.payoutsEnabled ? 'yes' : 'not yet'}</p>
            {c.merchant.businessName && <p>Name at Stripe: {c.merchant.businessName}</p>}
            {c.merchant.requirementsDue.length > 0 && <p className="sm:col-span-2">Stripe needs: {c.merchant.requirementsDue.join(', ')}</p>}
            <p className="text-xs text-stone-500 sm:col-span-2">
              Status from Stripe {c.merchant.statusSyncedAt ? utc(c.merchant.statusSyncedAt) : 'not checked yet'}
            </p>
          </div>
        )}
        {c.merchant && c.merchant.mode !== 'off' && (
          <ActionForm action={cardPaymentsOff.bind(null, c.id)} className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
            <input name="reason" placeholder="Reason (shown in their activity log)" required className="input max-w-sm" />
            <button className="btn-secondary text-red-700">Turn off their card payments</button>
          </ActionForm>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2">
          <h2 className="font-medium">People</h2>
          {c.members.map((m) => (
            <div key={m.id} className="flex justify-between gap-2 text-sm">
              <span>
                <Link href={`/platform/people/${m.id}`} className="hover:underline">
                  {m.name ?? m.email}
                </Link>{' '}
                <span className="text-stone-500">· {m.role}</span>
                {m.status !== 'active' && <span className="text-stone-400"> · {m.status}</span>}
                <div className="text-xs text-stone-500">{m.email}</div>
              </span>
              <span className="text-xs text-stone-500">seen {utc(m.lastSeenAt, false)}</span>
            </div>
          ))}
        </section>
        <section className="card space-y-2">
          <h2 className="font-medium">Suspend</h2>
          {c.suspendedAt ? (
            <>
              <p className="text-sm">
                Suspended {utc(c.suspendedAt)}: {c.suspendedReason}
              </p>
              <ActionForm action={restoreCompany.bind(null, c.id)}>
                <button className="btn">Restore the business</button>
              </ActionForm>
            </>
          ) : (
            <ActionForm action={suspendCompany.bind(null, c.id)} className="space-y-2">
              <p className="text-sm text-stone-600">
                Locks everyone out (web, registers and handhelds) with your reason shown, until you restore it. Nothing is deleted.
              </p>
              <input name="reason" placeholder="Reason the business will see" required className="input" />
              <button className="btn-secondary text-red-700">Suspend</button>
            </ActionForm>
          )}
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">Transactions</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Receipt</th>
                <th className="px-4 py-2">Store · cashier</th>
                <th className="px-4 py-2">Paid with</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id} className="border-t border-stone-100">
                  <td className="px-4 py-2 text-stone-500">{utc(t.createdAt)}</td>
                  <td className="px-4 py-2">{t.receiptNumber ? `#${t.receiptNumber}` : '—'}</td>
                  <td className="px-4 py-2">
                    {t.location}
                    {t.cashier && <span className="text-stone-500"> · {t.cashier}</span>}
                  </td>
                  <td className="px-4 py-2">
                    {t.payments
                      .filter((p) => p.status !== 'canceled')
                      .map((p, i) => (
                        <span key={i} className={`mr-2 ${p.status === 'succeeded' ? '' : 'text-red-700'}`}>
                          {METHOD[p.method] ?? p.method} {money(p.amountMinor)}
                          {p.status !== 'succeeded' && ` (${p.status})`}
                        </span>
                      ))}
                  </td>
                  <td className="px-4 py-2 capitalize">
                    {t.status}
                    {t.refundedMinor > 0 && <span className="ml-1 text-xs text-red-700">refunded {money(t.refundedMinor)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(t.totalMinor)}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-stone-500">
                    No sales yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex gap-4 text-sm">
          {before && (
            <Link href={`/platform/companies/${c.id}`} className="hover:underline">
              Newest
            </Link>
          )}
          {nextBefore && (
            <Link href={`/platform/companies/${c.id}?before=${encodeURIComponent(nextBefore)}`} className="hover:underline">
              Older →
            </Link>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link href={`/platform/activity?tenantId=${c.id}`} className="text-sm text-stone-500 hover:underline">
            All activity
          </Link>
        </div>
        <div className="card space-y-1 text-sm">
          {entries.map((e) => (
            <div key={e.id} className="flex justify-between gap-3">
              <span>
                <code className="text-xs">{e.action}</code>
                {e.targetId && <span className="text-stone-500"> · {e.targetId}</span>}
                <span className="text-stone-500"> · {e.actor ?? e.actorEmail ?? 'system'}</span>
              </span>
              <span className="text-xs text-stone-500">{utc(e.createdAt)}</span>
            </div>
          ))}
          {entries.length === 0 && <p className="text-stone-500">Nothing yet.</p>}
        </div>
      </section>
    </div>
  );
}

function billingNote(c: Company): string {
  if (!c.billing) return 'No billing record';
  if (c.billing.standing === 'trial') return `Trial ends ${utc(c.billing.trialEndsAt, false)}`;
  if (c.billing.currentPeriodEnd)
    return `${c.billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${utc(c.billing.currentPeriodEnd, false)} · ${c.billing.provider ?? ''}`;
  return c.billing.status ?? '';
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

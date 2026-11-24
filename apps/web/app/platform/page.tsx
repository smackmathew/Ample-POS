import Link from 'next/link';
import { api } from '@/lib/api';
import { METHOD, STANDING, usd, type Overview, type Standing } from '@/lib/platform';

export default async function PlatformOverview({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days = '30' } = await searchParams;
  const range = ['7', '30', '90'].includes(days) ? days : '30';
  const o = await api<Overview>(`/platform/overview?days=${range}`);
  const max = Math.max(1, ...o.daily.map((d) => d.grossMinor));

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <nav className="flex gap-1 text-sm">
          {['7', '30', '90'].map((d) => (
            <Link key={d} href={`/platform?days=${d}`} className={`rounded px-3 py-1 ${range === d ? 'bg-stone-900 text-white' : 'bg-white hover:bg-stone-100'}`}>
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Monthly recurring revenue" value={usd(o.mrrMinor)} />
        <Stat label="Companies" value={String(o.companies.total)} note={`${o.companies.new} new in ${o.days} days`} />
        <Stat label={`Sales processed, ${o.days} days`} value={usd(o.sales.grossMinor)} note={`${o.sales.count.toLocaleString()} sales · ${usd(o.sales.refundsMinor)} refunded`} />
        <Link href="/platform/issues" className="card hover:border-brand">
          <p className="text-sm text-stone-500">Open issues</p>
          <p className={`text-2xl font-semibold ${o.issues.high ? 'text-red-700' : ''}`}>{o.issues.total}</p>
          <p className="text-xs text-stone-500">{o.issues.high} need attention now</p>
        </Link>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Sales per day, all companies</h2>
          <span className="text-xs text-stone-500">Signups shown as dots</span>
        </div>
        <div className="mt-4 flex h-40 items-end gap-0.5" role="img" aria-label="Sales per day">
          {o.daily.map((d) => (
            <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end" title={`${d.date}: ${usd(d.grossMinor)}, ${d.sales} sales, ${d.signups} signups`}>
              {d.signups > 0 && <span className="mx-auto mb-1 h-1.5 w-1.5 rounded-full bg-sky-600" />}
              <div className="rounded-t bg-brand/80 group-hover:bg-brand" style={{ height: `${Math.max(d.grossMinor ? 2 : 0, (d.grossMinor / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-stone-500">
          <span>{o.daily[0]?.date}</span>
          <span>{o.daily.at(-1)?.date}</span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-2">
          <h2 className="font-medium">Companies by billing</h2>
          {(Object.keys(STANDING) as Standing[]).map((s) => (
            <Link key={s} href={`/platform/companies?status=${s}`} className="flex justify-between text-sm hover:underline">
              <span>{STANDING[s][0]}</span>
              <span className="tabular-nums">{o.companies.byStanding[s]}</span>
            </Link>
          ))}
          <Link href="/platform/companies?status=suspended" className="flex justify-between text-sm hover:underline">
            <span>Suspended</span>
            <span className="tabular-nums">{o.companies.suspended}</span>
          </Link>
        </section>
        <section className="card space-y-2">
          <h2 className="font-medium">How customers paid</h2>
          {Object.keys(o.tenders).length === 0 && <p className="text-sm text-stone-500">No payments yet.</p>}
          {Object.entries(o.tenders).map(([method, amount]) => (
            <div key={method} className="flex justify-between text-sm">
              <span>{METHOD[method] ?? method}</span>
              <span className="tabular-nums">{usd(amount)}</span>
            </div>
          ))}
          <p className="pt-2 text-xs text-stone-500">
            {o.users.activeLast7Days} of {o.users.total} people signed in during the last 7 days
          </p>
        </section>
        <section className="card space-y-2">
          <h2 className="font-medium">Busiest companies</h2>
          {o.topCompanies.length === 0 && <p className="text-sm text-stone-500">No sales yet.</p>}
          {o.topCompanies.map((c) => (
            <Link key={c.id} href={`/platform/companies/${c.id}`} className="flex justify-between text-sm hover:underline">
              <span>{c.name}</span>
              <span className="tabular-nums">{usd(c.grossMinor)}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-stone-500">{note}</p>}
    </div>
  );
}

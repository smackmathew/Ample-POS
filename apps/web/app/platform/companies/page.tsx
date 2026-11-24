import Link from 'next/link';
import { api } from '@/lib/api';
import { MERCHANT, PLAN_NAME, STANDING, usd, utc, type CompanyRow } from '@/lib/platform';

const FILTERS = [
  ['all', 'All'],
  ['trial', 'Trial'],
  ['active', 'Subscribed'],
  ['past_due', 'Payment failing'],
  ['lapsed', 'Trial ended'],
  ['suspended', 'Suspended'],
] as const;

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ search?: string; status?: string }> }) {
  const { search = '', status = 'all' } = await searchParams;
  const filter = FILTERS.some(([k]) => k === status) ? status : 'all';
  const companies = await api<CompanyRow[]>(`/platform/companies?status=${filter}&search=${encodeURIComponent(search)}`);

  return (
    <div className="max-w-7xl space-y-4">
      <h1 className="text-2xl font-semibold">Companies</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 text-sm">
          {FILTERS.map(([key, label]) => (
            <Link
              key={key}
              href={`/platform/companies?status=${key}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
              className={`rounded-lg px-3 py-1 ${filter === key ? 'bg-brand text-white' : 'bg-white hover:bg-stone-100'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="flex gap-2">
          <input type="hidden" name="status" value={filter} />
          <input name="search" defaultValue={search} placeholder="Name, link or member email" className="input w-64" />
          <button className="btn-secondary">Search</button>
        </form>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2">Company</th>
              <th className="px-4 py-2">Billing</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Cards</th>
              <th className="px-4 py-2 text-right">MRR</th>
              <th className="px-4 py-2 text-right">Sales, 30 days</th>
              <th className="px-4 py-2 text-right">Tools</th>
              <th className="px-4 py-2 text-right">Stores · people</th>
              <th className="px-4 py-2">Last activity</th>
              <th className="px-4 py-2 text-right">Issues</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} className="border-t border-stone-100">
                <td className="px-4 py-2">
                  <Link href={`/platform/companies/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-stone-500">{c.ownerEmail ?? c.slug}</div>
                </td>
                <td className="px-4 py-2">
                  {c.suspendedAt ? (
                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Suspended</span>
                  ) : c.standing ? (
                    <span className={`rounded px-2 py-0.5 text-xs ${STANDING[c.standing][1]}`}>{STANDING[c.standing][0]}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {c.plan ? PLAN_NAME[c.plan] : '—'}
                  {c.websiteAddon && <div className="text-stone-500">+ online store</div>}
                </td>
                <td className={`px-4 py-2 text-xs ${MERCHANT[c.merchant]?.[1] ?? ''}`}>{MERCHANT[c.merchant]?.[0] ?? c.merchant}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.mrrMinor ? usd(c.mrrMinor) : '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {usd(c.gross30Minor)}
                  <div className="text-xs text-stone-500">{c.sales30} sales</div>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{c.toolsOn}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {c.locations} · {c.members}
                </td>
                <td className="px-4 py-2 text-stone-500">{c.lastActivityAt ? utc(c.lastActivityAt, false) : '—'}</td>
                <td className="px-4 py-2 text-right">{c.issues > 0 ? <span className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-800">{c.issues}</span> : '—'}</td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-stone-500">
                  No companies match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

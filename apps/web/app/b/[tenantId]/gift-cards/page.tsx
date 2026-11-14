import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDate, homeTimeZone } from '@/lib/time';
import type { CurrentTenant, GiftCardSummary, Location } from '@/lib/types';
import { issueGiftCard } from '../gift-card-actions';

export default async function GiftCardsPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ search?: string }> }) {
  const { tenantId } = await params;
  const { search = '' } = await searchParams;
  const [current, locations, cards] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
    api<GiftCardSummary[]>(`/gift-cards?limit=100&search=${encodeURIComponent(search)}`, { tenantId }),
  ]);
  const tz = homeTimeZone(locations);
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  const outstanding = cards.filter((c) => c.status === 'active').reduce((n, c) => n + c.balanceMinor, 0);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Gift cards</h1>
        <p className="mt-1 text-stone-600">Sell gift cards at the register (“Sell a gift card”) and take them as payment.</p>
      </div>

      <details className="card">
        <summary className="cursor-pointer font-medium">Give out a card without a sale</summary>
        <p className="mt-2 text-sm text-stone-600">For donations, raffles or making something right. Cards sold to customers go through the register.</p>
        <ActionForm action={issueGiftCard.bind(null, tenantId)} className="mt-3 grid gap-3 sm:grid-cols-3">
          <input name="amount" inputMode="decimal" placeholder="Amount, e.g. 25.00" required className="input" />
          <input name="code" placeholder="Printed card code (optional)" autoComplete="off" className="input" />
          <input name="note" placeholder="Why, e.g. school raffle" required className="input" />
          <div>
            <button className="btn">Create card</button>
          </div>
        </ActionForm>
      </details>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <form className="flex gap-2">
            <input name="search" defaultValue={search} placeholder="Search by code" className="input max-w-xs" autoComplete="off" />
            <button className="btn-secondary">Search</button>
          </form>
          {!search && <p className="text-sm text-stone-600">Owed on active cards shown: {money(outstanding)}</p>}
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Code</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Last used</th>
                <th className="pb-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-t border-stone-100">
                  <td className="py-2 font-mono">
                    <Link href={`/b/${tenantId}/gift-cards/${c.id}`} className="hover:underline">
                      {c.code}
                    </Link>
                  </td>
                  <td>{c.status === 'void' ? <span className="text-stone-500">Voided</span> : 'Active'}</td>
                  <td className="text-stone-500">{formatDate(c.createdAt, tz)}</td>
                  <td className="text-stone-500">{c.lastUsedAt ? formatDate(c.lastUsedAt, tz) : '—'}</td>
                  <td className="text-right tabular-nums">{money(c.balanceMinor)}</td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-stone-500">
                    {search ? `No card codes contain “${search}”.` : 'No gift cards yet.'}
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

import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDateTime, homeTimeZone } from '@/lib/time';
import type { CurrentTenant, GiftCard, Location } from '@/lib/types';
import { adjustGiftCard, voidGiftCard } from '../../gift-card-actions';

const KIND: Record<GiftCard['entries'][number]['kind'], string> = {
  load: 'Sold / reloaded',
  redeem: 'Spent',
  refund: 'Refund',
  adjust: 'Adjusted',
  void: 'Voided',
};

export default async function GiftCardPage({ params }: { params: Promise<{ tenantId: string; cardId: string }> }) {
  const { tenantId, cardId } = await params;
  const [current, card, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<GiftCard>(`/gift-cards/${cardId}`, { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
  ]);
  const tz = homeTimeZone(locations);
  const money = (n: number) => formatMoney(n, current.tenant.currency);

  return (
    <div className="max-w-3xl space-y-6">
      <Link href={`/b/${tenantId}/gift-cards`} className="text-sm text-stone-500 hover:underline">
        ← Gift cards
      </Link>
      <div className="card space-y-1">
        <p className="font-mono text-lg">{card.code}</p>
        <p className="text-3xl font-semibold tabular-nums">{money(card.balanceMinor)}</p>
        <p className="text-sm text-stone-500">{card.status === 'void' ? 'Voided: it can’t be used or reloaded.' : 'Active'}</p>
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">History</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {card.entries.map((e) => (
                <tr key={e.id} className="border-t border-stone-100 first:border-0">
                  <td className="py-1.5 text-stone-500">{formatDateTime(e.createdAt, tz)}</td>
                  <td>
                    {KIND[e.kind]}
                    {e.saleId && (
                      <>
                        {' · '}
                        <Link href={`/b/${tenantId}/sales/${e.saleId}`} className="hover:underline">
                          {e.receiptNumber ? `receipt #${e.receiptNumber}` : 'sale'}
                        </Link>
                      </>
                    )}
                    {e.note && <span className="text-stone-500"> · {e.note}</span>}
                  </td>
                  <td className={`text-right tabular-nums ${e.amountMinor < 0 ? 'text-red-700' : 'text-teal-700'}`}>
                    {e.amountMinor > 0 ? '+' : '−'}
                    {money(Math.abs(e.amountMinor))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {card.status === 'active' && (
        <>
          <ActionForm action={adjustGiftCard.bind(null, tenantId, card.id)} className="card flex flex-wrap items-start gap-2">
            <h2 className="w-full font-medium">Adjust balance</h2>
            <input name="amount" inputMode="decimal" placeholder="10.00 or -10.00" required className="input w-36" />
            <input name="note" placeholder="Reason" required className="input min-w-48 flex-1" />
            <button className="btn-secondary">Adjust</button>
          </ActionForm>
          <ActionForm action={voidGiftCard.bind(null, tenantId, card.id)} className="card space-y-2 border-red-200">
            <h2 className="font-medium">Void card</h2>
            <p className="text-sm text-stone-600">For a lost or stolen card. Whatever is left ({money(card.balanceMinor)}) is taken off, and the code stops working for good.</p>
            <input name="note" placeholder="Reason, e.g. reported stolen" required className="input" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" /> Void this card
            </label>
            <button className="btn-secondary text-red-700">Void</button>
          </ActionForm>
        </>
      )}
    </div>
  );
}

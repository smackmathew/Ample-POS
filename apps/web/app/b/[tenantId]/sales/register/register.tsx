'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import { formatMoney, parseMoney } from '@/lib/money';
import { estimateLine } from '@/lib/pricing';
import type { Sale } from '@/lib/types';
import { emailReceiptToCustomer, type CustomerPick } from '../../customer-actions';
import { redeemReward, removeReward } from '../../loyalty-actions';
import { cancelPayment, cardStep, createSale, findProducts, payCash, payGiftCard, startCard, voidSale, type CatalogHit } from '../../sales-actions';
import { CustomerPicker } from '../customer-picker';

interface CartLine extends CatalogHit {
  quantity: number;
  discountMinor: number;
}

interface Props {
  tenantId: string;
  sessionId: string;
  currency: string;
  taxRateBps: number;
  canDiscount: boolean;
  /** True when payments go to the simulated processor, so the screen offers approve/decline. */
  simulatedReader: boolean;
  /** The Customers tool is on and this cashier may use it. */
  customers: boolean;
  /** The Gift cards tool is on: sell them, and take them as payment. */
  giftCards: boolean;
}

/** A gift card being sold on this sale: a printed card's code, or blank to make one up. */
interface GiftCardLine {
  key: string;
  code: string;
  amountMinor: number;
}

/** How often to ask the processor about a card payment while waiting on the reader. */
const CARD_POLL_MS = 2000;

export function Register({ tenantId, sessionId, currency, taxRateBps, canDiscount, simulatedReader, customers, giftCards }: Props) {
  const money = (minor: number) => formatMoney(minor, currency);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [sale, setSale] = useState<Sale | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState('');
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [cards, setCards] = useState<GiftCardLine[]>([]);
  const [cardForm, setCardForm] = useState<{ amount: string; code: string } | null>(null);
  const [giftCode, setGiftCode] = useState('');
  const [receiptSent, setReceiptSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onData: (data: T) => void) =>
    startTransition(async () => {
      setError('');
      const result = await fn();
      if (result.ok) onData(result.data);
      else setError(result.error);
    });

  const estimate = useMemo(() => {
    const lines = cart.map((l) => estimateLine(l.priceMinor, l.quantity, l.discountMinor, taxRateBps));
    return {
      subtotal: cart.reduce((n, l) => n + l.priceMinor * l.quantity, 0),
      discount: cart.reduce((n, l) => n + l.discountMinor, 0),
      tax: lines.reduce((n, l) => n + l.taxMinor, 0),
      // Gift cards aren't taxed.
      total: lines.reduce((n, l) => n + l.totalMinor, 0) + cards.reduce((n, c) => n + c.amountMinor, 0),
      cards: cards.reduce((n, c) => n + c.amountMinor, 0),
    };
  }, [cart, cards, taxRateBps]);

  const add = (hit: CatalogHit) => {
    setCart((c) => {
      const existing = c.find((l) => l.variantId === hit.variantId);
      return existing ? c.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l)) : [...c, { ...hit, quantity: 1, discountMinor: 0 }];
    });
    setHits([]);
    setQuery('');
    searchRef.current?.focus();
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    run(
      () => findProducts(tenantId, query),
      (found) => {
        // A barcode scan or exact SKU adds straight to the cart.
        if (found.length === 1) add(found[0]!);
        else if (!found.length) setError(`Nothing matches “${query}”`);
        else setHits(found);
      },
    );
  };

  const update = (variantId: string, patch: Partial<CartLine>) =>
    setCart((c) => c.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0));

  const charge = () =>
    run(
      () =>
        createSale(tenantId, {
          id: crypto.randomUUID(),
          registerSessionId: sessionId,
          lines: [
            ...cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, discountMinor: l.discountMinor })),
            ...cards.map((c) => ({ giftCard: { code: c.code.trim() || undefined, amountMinor: c.amountMinor } })),
          ],
          customerId: customer?.id ?? null,
        }),
      (s) => {
        setSale(s);
        setTendered('');
        setChange(null);
      },
    );

  const pendingCard = sale?.payments.find((p) => p.method === 'card' && p.status === 'pending');

  // While a card is on the reader, keep asking the processor how it went.
  useEffect(() => {
    if (!sale || !pendingCard || simulatedReader) return;
    const timer = setInterval(async () => {
      const result = await cardStep(tenantId, sale.id, pendingCard.id, 'sync');
      if (result.ok) setSale(result.data);
    }, CARD_POLL_MS);
    return () => clearInterval(timer);
  }, [sale, pendingCard, simulatedReader, tenantId]);

  const newSale = () => {
    setSale(null);
    setCart([]);
    setCards([]);
    setCardForm(null);
    setCustomer(null);
    setReceiptSent(false);
    setChange(null);
    setError('');
    searchRef.current?.focus();
  };

  const quickCash = sale ? [...new Set([sale.dueMinor, ...[500, 1000, 2000, 5000, 10000].map((n) => Math.ceil(sale.dueMinor / n) * n)])].slice(0, 4) : [];

  // Receipt ---------------------------------------------------------------------
  if (sale?.status === 'completed' || sale?.status === 'voided') {
    return (
      <div className="card max-w-md space-y-3">
        <h2 className="text-xl font-semibold">{sale.status === 'completed' ? `Sale #${sale.receiptNumber} complete` : 'Sale voided'}</h2>
        {change !== null && change > 0 && <p className="rounded-md bg-amber-50 p-3 text-lg font-semibold">Change due: {money(change)}</p>}
        <SaleTotals sale={sale} money={money} />
        {sale.status === 'completed' &&
          sale.lines
            .filter((l) => l.kind === 'gift_card')
            .map((l) => (
              <p key={l.id} className="rounded-md bg-teal-50 p-3 text-sm">
                <strong>{l.description}</strong> now holds {money(l.totalMinor)} more. The code is on the receipt.
              </p>
            ))}
        {sale.status === 'completed' && sale.loyalty && (
          <p className="text-sm">
            {sale.customer!.name} earned <strong>{sale.loyalty.earnedPoints} points</strong> · balance {sale.loyalty.balance}
          </p>
        )}
        {sale.status === 'completed' && sale.customer?.email && (
          <div className="text-sm">
            {receiptSent ? (
              <p className="text-teal-700">Receipt sent to {sale.customer.email}.</p>
            ) : (
              <button className="btn-secondary" disabled={pending} onClick={() => run(() => emailReceiptToCustomer(tenantId, sale.id), () => setReceiptSent(true))}>
                Email receipt to {sale.customer.email}
              </button>
            )}
            {error && <p className="mt-1 text-red-700">{error}</p>}
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn" onClick={newSale} autoFocus>
            New sale
          </button>
          {sale.status === 'completed' && (
            <Link className="btn-secondary" href={`/b/${tenantId}/sales/${sale.id}`}>
              View receipt
            </Link>
          )}
        </div>
      </div>
    );
  }

  // Payment ---------------------------------------------------------------------
  if (sale) {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-medium">Order</h2>
            {sale.customer && <span className="text-sm text-stone-500">for {sale.customer.name}</span>}
          </div>
          <SaleTotals sale={sale} money={money} />
        </div>
        <div className="card space-y-4">
          {/* Includes any card still on the reader: the customer hasn't paid that yet. */}
          <p className="text-3xl font-semibold tabular-nums">{money(sale.totalMinor - sale.paidMinor)} due</p>
          {error && <p className="text-sm text-red-700">{error}</p>}

          {pendingCard ? (
            <div className="space-y-3 rounded-md border border-sky-200 bg-sky-50 p-4">
              <p className="font-medium">Waiting for card: {money(pendingCard.amountMinor)}</p>
              {pendingCard.lastError && <p className="text-sm text-red-700">{pendingCard.lastError} Ask for another card or cancel.</p>}
              {simulatedReader && (
                <div className="flex gap-2">
                  <button className="btn" disabled={pending} onClick={() => run(() => cardStep(tenantId, sale.id, pendingCard.id, 'approve'), setSale)}>
                    Simulate approved card
                  </button>
                  <button className="btn-secondary" disabled={pending} onClick={() => run(() => cardStep(tenantId, sale.id, pendingCard.id, 'decline'), setSale)}>
                    Simulate decline
                  </button>
                </div>
              )}
              <button className="btn-secondary" disabled={pending} onClick={() => run(() => cardStep(tenantId, sale.id, pendingCard.id, 'cancel'), setSale)}>
                Cancel card payment
              </button>
            </div>
          ) : (
            <>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const amount = parseMoney(tendered);
                  if (!amount) return setError('Enter the cash received, like 20.00');
                  run(
                    () => payCash(tenantId, sale.id, crypto.randomUUID(), amount),
                    (r) => {
                      setSale(r.sale);
                      setChange(r.payment.changeMinor ?? 0);
                      setTendered('');
                    },
                  );
                }}
              >
                <label className="block text-sm font-medium">Cash received</label>
                <div className="flex gap-2">
                  <input className="input max-w-40" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="0.00" autoFocus />
                  <button className="btn" disabled={pending}>
                    Take cash
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {quickCash.map((n) => (
                    <button type="button" key={n} className="btn-secondary" onClick={() => setTendered((n / 100).toFixed(2))}>
                      {money(n)}
                    </button>
                  ))}
                </div>
              </form>
              <button
                className="btn w-full"
                disabled={pending || sale.dueMinor === 0}
                onClick={() => run(() => startCard(tenantId, sale.id, crypto.randomUUID(), sale.dueMinor), (r) => setSale(r.sale))}
              >
                Charge {money(sale.dueMinor)} to card
              </button>
              {giftCards && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!giftCode.trim()) return setError('Enter or scan the gift card code');
                    run(
                      () => payGiftCard(tenantId, sale.id, crypto.randomUUID(), giftCode),
                      (r) => {
                        setSale(r.sale);
                        setGiftCode('');
                      },
                    );
                  }}
                >
                  <input className="input" value={giftCode} onChange={(e) => setGiftCode(e.target.value)} placeholder="Gift card code" autoComplete="off" />
                  <button className="btn-secondary whitespace-nowrap" disabled={pending || sale.dueMinor === 0}>
                    Pay with gift card
                  </button>
                </form>
              )}
              {sale.payments
                .filter((p) => p.method === 'gift_card' && p.status === 'succeeded')
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md bg-stone-50 px-3 py-2 text-sm">
                    <span>
                      Gift card ••••{p.giftCard?.last4}: {money(p.amountMinor)} · {money(p.giftCard?.balanceMinor ?? 0)} left
                    </span>
                    <button className="text-stone-500 hover:underline" disabled={pending} onClick={() => run(() => cancelPayment(tenantId, sale.id, p.id), setSale)}>
                      Undo
                    </button>
                  </div>
                ))}
            </>
          )}

          {sale.loyalty && sale.customer && sale.paidMinor === 0 && !pendingCard && (
            <RewardPanel
              sale={sale}
              money={money}
              disabled={pending}
              onRedeem={(n) => run(() => redeemReward(tenantId, sale.id, n), setSale)}
              onRemove={() => run(() => removeReward(tenantId, sale.id), setSale)}
            />
          )}

          {sale.payments.every((p) => p.status !== 'succeeded' || p.method === 'gift_card') && !pendingCard && (
            <button className="text-sm text-red-700 hover:underline" disabled={pending} onClick={() => run(() => voidSale(tenantId, sale.id), setSale)}>
              Void sale
            </button>
          )}
        </div>
      </div>
    );
  }

  // Cart ------------------------------------------------------------------------
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <form onSubmit={search} className="flex gap-2">
          <input
            ref={searchRef}
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scan a barcode, or search by name or SKU"
            autoFocus
          />
          <button className="btn-secondary" disabled={pending}>
            Find
          </button>
        </form>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {hits.length > 0 && (
          <ul className="card divide-y divide-stone-100 p-0">
            {hits.map((h) => (
              <li key={h.variantId}>
                <button className="flex w-full justify-between px-4 py-2 text-left text-sm hover:bg-stone-50" onClick={() => add(h)}>
                  <span>
                    {h.label} {h.sku && <span className="text-stone-400">· {h.sku}</span>}
                  </span>
                  <span>{money(h.priceMinor)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Item</th>
                <th className="pb-2">Qty</th>
                {canDiscount && <th className="pb-2">Discount</th>}
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {cart.map((l) => (
                <tr key={l.variantId} className="border-t border-stone-100">
                  <td className="py-2">
                    {l.label}
                    <div className="text-xs text-stone-500">{money(l.priceMinor)} each</div>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button className="btn-secondary px-2 py-1" onClick={() => update(l.variantId, { quantity: l.quantity - 1 })} aria-label="Remove one">
                        −
                      </button>
                      <span className="w-8 text-center tabular-nums">{l.quantity}</span>
                      <button className="btn-secondary px-2 py-1" onClick={() => update(l.variantId, { quantity: l.quantity + 1 })} aria-label="Add one">
                        +
                      </button>
                    </div>
                  </td>
                  {canDiscount && (
                    <td>
                      <input
                        className="input w-24"
                        inputMode="decimal"
                        placeholder="0.00"
                        defaultValue={l.discountMinor ? (l.discountMinor / 100).toFixed(2) : ''}
                        onBlur={(e) => {
                          const v = e.target.value.trim() ? parseMoney(e.target.value) : 0;
                          if (v === null || v > l.priceMinor * l.quantity) {
                            setError(`Discount on ${l.label} must be between 0 and ${money(l.priceMinor * l.quantity)}`);
                            return;
                          }
                          setError('');
                          update(l.variantId, { discountMinor: v });
                        }}
                      />
                    </td>
                  )}
                  <td className="text-right tabular-nums">{money(l.priceMinor * l.quantity - l.discountMinor)}</td>
                </tr>
              ))}
              {cards.map((c) => (
                <tr key={c.key} className="border-t border-stone-100">
                  <td className="py-2">
                    Gift card{c.code.trim() ? ` ${c.code.trim()}` : ''}
                    <div className="text-xs text-stone-500">{c.code.trim() ? 'Printed card, or reload' : 'New code, printed on the receipt'} · no tax</div>
                  </td>
                  <td>
                    <button className="text-xs text-stone-500 hover:underline" onClick={() => setCards((cs) => cs.filter((x) => x.key !== c.key))}>
                      Remove
                    </button>
                  </td>
                  {canDiscount && <td />}
                  <td className="text-right tabular-nums">{money(c.amountMinor)}</td>
                </tr>
              ))}
              {cart.length === 0 && cards.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-stone-500">
                    Scan or search to add items.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {giftCards &&
          (cardForm ? (
            <form
              className="card flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const amount = parseMoney(cardForm.amount);
                if (!amount || amount < 100) return setError('Enter the gift card amount, $1.00 or more');
                setError('');
                setCards((cs) => [...cs, { key: crypto.randomUUID(), code: cardForm.code, amountMinor: amount }]);
                setCardForm(null);
              }}
            >
              <label className="text-sm">
                Amount
                <input className="input mt-1 w-28" inputMode="decimal" placeholder="25.00" value={cardForm.amount} onChange={(e) => setCardForm({ ...cardForm, amount: e.target.value })} autoFocus />
              </label>
              <label className="flex-1 text-sm">
                Card code <span className="text-stone-400">(printed card or reload; blank for a new code)</span>
                <input className="input mt-1" value={cardForm.code} onChange={(e) => setCardForm({ ...cardForm, code: e.target.value })} autoComplete="off" />
              </label>
              <button className="btn-secondary">Add gift card</button>
              <button type="button" className="text-sm text-stone-500 hover:underline" onClick={() => setCardForm(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button className="text-sm text-stone-600 hover:underline" onClick={() => setCardForm({ amount: '', code: '' })}>
              + Sell a gift card
            </button>
          ))}
      </div>

      <div className="card h-fit space-y-2">
        {customers && (
          <div className="border-b border-stone-100 pb-3">
            <CustomerPicker tenantId={tenantId} value={customer} onChange={setCustomer} disabled={pending} />
          </div>
        )}
        <Row label="Subtotal" value={money(estimate.subtotal)} />
        {estimate.discount > 0 && <Row label="Discounts" value={`−${money(estimate.discount)}`} />}
        {estimate.cards > 0 && <Row label="Gift cards" value={money(estimate.cards)} />}
        <Row label="Tax" value={money(estimate.tax)} />
        <Row label="Total" value={money(estimate.total)} strong />
        <button className="btn mt-2 w-full py-3 text-base" disabled={(!cart.length && !cards.length) || pending} onClick={charge}>
          Charge {money(estimate.total)}
        </button>
        {cart.length + cards.length > 0 && (
          <button
            className="w-full text-sm text-stone-500 hover:underline"
            onClick={() => {
              setCart([]);
              setCards([]);
            }}
          >
            Clear cart
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-200 pt-2 text-lg font-semibold' : 'text-sm'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function SaleTotals({ sale, money }: { sale: Sale; money: (n: number) => string }) {
  return (
    <div className="space-y-1 text-sm">
      {sale.lines.map((l) => (
        <div key={l.id} className="flex justify-between">
          <span>
            {l.quantity} × {l.description}
          </span>
          <span className="tabular-nums">{money(l.unitPriceMinor * l.quantity - (l.discountMinor - l.rewardMinor))}</span>
        </div>
      ))}
      <div className="mt-2 border-t border-stone-200 pt-2">
        <Row label="Subtotal" value={money(sale.subtotalMinor - sale.discountMinor + sale.rewardMinor)} />
        {sale.rewardMinor > 0 && <Row label="Loyalty reward" value={`−${money(sale.rewardMinor)}`} />}
        <Row label="Tax" value={money(sale.taxMinor)} />
        <Row label="Total" value={money(sale.totalMinor)} strong />
      </div>
      {sale.payments
        .filter((p) => p.status === 'succeeded')
        .map((p) => (
          <Row
            key={p.id}
            label={p.method === 'cash' ? `Cash (tendered ${money(p.tenderedMinor ?? p.amountMinor)})` : p.method === 'gift_card' ? `Gift card ••••${p.giftCard?.last4 ?? ''}` : 'Card'}
            value={money(p.amountMinor)}
          />
        ))}
    </div>
  );
}

/** The customer's points before payment: use a reward, or take it back off. */
function RewardPanel({
  sale,
  money,
  disabled,
  onRedeem,
  onRemove,
}: {
  sale: Sale;
  money: (n: number) => string;
  disabled: boolean;
  onRedeem: (rewards: number) => void;
  onRemove: () => void;
}) {
  const loyalty = sale.loyalty!;
  const name = sale.customer!.name.split(/\s+/)[0];
  // No more rewards than the customer has, or than the items are worth.
  const itemsMinor = sale.lines.filter((l) => l.kind === 'item').reduce((n, l) => n + l.unitPriceMinor * l.quantity - l.discountMinor, 0);
  const most = Math.min(loyalty.rewardsAvailable, Math.floor(itemsMinor / loyalty.rewardValueMinor));
  const [count, setCount] = useState(1);

  if (sale.rewardPoints > 0) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md bg-teal-50 p-3 text-sm">
        <span>
          Reward used: <strong>−{money(sale.rewardMinor)}</strong> ({sale.rewardPoints} points). {name} has {loyalty.balance} left.
        </span>
        <button className="text-stone-600 hover:underline" disabled={disabled} onClick={onRemove}>
          Take off
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-stone-200 p-3 text-sm">
      <p>
        {name} has <strong>{loyalty.balance} points</strong>.{' '}
        {loyalty.rewardsAvailable === 0
          ? `${loyalty.rewardPoints - Math.max(0, loyalty.balance)} more for ${money(loyalty.rewardValueMinor)} off.`
          : `${loyalty.rewardPoints} points = ${money(loyalty.rewardValueMinor)} off.`}
      </p>
      {loyalty.rewardsAvailable > 0 &&
        (most > 0 ? (
          <div className="flex items-center gap-2">
            {most > 1 && (
              <select className="input w-auto" value={Math.min(count, most)} onChange={(e) => setCount(Number(e.target.value))} aria-label="Rewards to use">
                {Array.from({ length: most }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} × {money(loyalty.rewardValueMinor)}
                  </option>
                ))}
              </select>
            )}
            <button className="btn-secondary" disabled={disabled} onClick={() => onRedeem(Math.min(count, most))}>
              Use {money(loyalty.rewardValueMinor * Math.min(count, most))} reward
            </button>
          </div>
        ) : (
          <p className="text-stone-500">The reward is worth more than this sale.</p>
        ))}
    </div>
  );
}

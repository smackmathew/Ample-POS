'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import { formatMoney, parseMoney } from '@/lib/money';
import { estimateLine } from '@/lib/pricing';
import type { Sale } from '@/lib/types';
import { cardStep, createSale, findProducts, payCash, startCard, voidSale, type CatalogHit } from '../../sales-actions';

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
}

/** How often to ask the processor about a card payment while waiting on the reader. */
const CARD_POLL_MS = 2000;

export function Register({ tenantId, sessionId, currency, taxRateBps, canDiscount, simulatedReader }: Props) {
  const money = (minor: number) => formatMoney(minor, currency);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [sale, setSale] = useState<Sale | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState('');
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
      total: lines.reduce((n, l) => n + l.totalMinor, 0),
    };
  }, [cart, taxRateBps]);

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
          lines: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity, discountMinor: l.discountMinor })),
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
          <h2 className="font-medium">Order</h2>
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
            </>
          )}

          {sale.paidMinor === 0 && !pendingCard && (
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
              {cart.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-stone-500">
                    Scan or search to add items.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card h-fit space-y-2">
        <Row label="Subtotal" value={money(estimate.subtotal)} />
        {estimate.discount > 0 && <Row label="Discounts" value={`−${money(estimate.discount)}`} />}
        <Row label="Tax" value={money(estimate.tax)} />
        <Row label="Total" value={money(estimate.total)} strong />
        <button className="btn mt-2 w-full py-3 text-base" disabled={!cart.length || pending} onClick={charge}>
          Charge {money(estimate.total)}
        </button>
        {cart.length > 0 && (
          <button className="w-full text-sm text-stone-500 hover:underline" onClick={() => setCart([])}>
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
          <span className="tabular-nums">{money(l.unitPriceMinor * l.quantity - l.discountMinor)}</span>
        </div>
      ))}
      <div className="mt-2 border-t border-stone-200 pt-2">
        <Row label="Subtotal" value={money(sale.subtotalMinor - sale.discountMinor)} />
        <Row label="Tax" value={money(sale.taxMinor)} />
        <Row label="Total" value={money(sale.totalMinor)} strong />
      </div>
      {sale.payments
        .filter((p) => p.status === 'succeeded')
        .map((p) => (
          <Row key={p.id} label={p.method === 'cash' ? `Cash (tendered ${money(p.tenderedMinor ?? p.amountMinor)})` : 'Card'} value={money(p.amountMinor)} />
        ))}
    </div>
  );
}

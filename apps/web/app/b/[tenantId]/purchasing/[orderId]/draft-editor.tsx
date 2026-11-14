'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { formatMoney, parseMoney } from '@/lib/money';
import type { Location, PurchaseOrder, Supplier } from '@/lib/types';
import { finishOrder, lowStock, placeOrder, saveDraft, searchItems, type OrderItem } from '../../purchasing-actions';

interface Line {
  variantId: string;
  description: string;
  sku: string | null;
  quantity: string;
  cost: string;
}

const toLine = (item: { variantId: string; description: string; sku: string | null }, quantity: number, costMinor: number | null): Line => ({
  variantId: item.variantId,
  description: item.description,
  sku: item.sku,
  quantity: String(quantity),
  cost: costMinor === null ? '' : (costMinor / 100).toFixed(2),
});

/** Editing a draft order: items, quantities and costs, then placing it. */
export function DraftEditor({
  tenantId,
  order,
  suppliers,
  locations,
  currency,
  canEmail,
}: {
  tenantId: string;
  order: PurchaseOrder;
  suppliers: Supplier[];
  locations: Location[];
  currency: string;
  canEmail: boolean;
}) {
  const router = useRouter();
  const money = (n: number) => formatMoney(n, currency);
  const [supplierId, setSupplierId] = useState(order.supplierId);
  const [locationId, setLocationId] = useState(order.locationId);
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? '');
  const [note, setNote] = useState(order.note ?? '');
  const [lines, setLines] = useState<Line[]>(() => order.lines.map((l) => toLine(l, l.quantityOrdered, l.unitCostMinor)));
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<OrderItem[]>([]);
  const [threshold, setThreshold] = useState('5');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const supplier = suppliers.find((s) => s.id === supplierId);

  const change = (f: () => void) => {
    f();
    setDirty(true);
    setNotice('');
  };
  const add = (items: { variantId: string; description: string; sku: string | null; costMinor: number | null }[], quantity = 1) =>
    change(() => setLines((ls) => [...ls, ...items.filter((i) => !ls.some((l) => l.variantId === i.variantId)).map((i) => toLine(i, quantity, i.costMinor))]));

  const parsed = () => {
    const out = [];
    for (const l of lines) {
      const quantity = Number(l.quantity);
      const unitCostMinor = l.cost.trim() ? parseMoney(l.cost) : 0;
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Enter a whole quantity for ${l.description}`);
      if (unitCostMinor === null) throw new Error(`Enter a cost like 4.50 for ${l.description}`);
      out.push({ variantId: l.variantId, quantity, unitCostMinor });
    }
    return out;
  };
  const total = (() => {
    try {
      return parsed().reduce((n, l) => n + l.quantity * l.unitCostMinor, 0);
    } catch {
      return null;
    }
  })();

  const save = (then?: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    startTransition(async () => {
      setError('');
      let input;
      try {
        input = parsed();
      } catch (err) {
        return setError((err as Error).message);
      }
      const saved = await saveDraft(tenantId, order.id, { supplierId, locationId, note, expectedOn, lines: input });
      if (!saved.ok) return setError(saved.error);
      setDirty(false);
      if (!then) return setNotice('Draft saved');
      const result = await then();
      if (!result.ok) return setError(result.error);
      router.refresh();
    });

  const search = (e: FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const result = await searchItems(tenantId, query);
      if (!result.ok) return setError(result.error);
      if (!result.data.length) setError(`No stocked items match “${query}”`);
      else setError('');
      setFound(result.data);
    });
  };

  const addLow = () =>
    startTransition(async () => {
      const n = Number(threshold);
      if (!Number.isInteger(n) || n < 0) return setError('Enter a whole number of units');
      const result = await lowStock(tenantId, locationId, n);
      if (!result.ok) return setError(result.error);
      const fresh = result.data.filter((i) => !lines.some((l) => l.variantId === i.variantId));
      setError('');
      add(fresh, 1);
      setNotice(fresh.length ? `Added ${fresh.length} item${fresh.length === 1 ? '' : 's'} with ${n} or fewer in stock. Set how many to order.` : `Nothing else has ${n} or fewer in stock.`);
    });

  return (
    <div className="space-y-4">
      <section className="card grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          Supplier
          <select className="input mt-1" value={supplierId} onChange={(e) => change(() => setSupplierId(e.target.value))}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Deliver to
          <select className="input mt-1" value={locationId} onChange={(e) => change(() => setLocationId(e.target.value))}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Needed by
          <input type="date" className="input mt-1" value={expectedOn} onChange={(e) => change(() => setExpectedOn(e.target.value))} />
        </label>
        <label className="text-sm">
          Note for the supplier
          <input className="input mt-1" value={note} onChange={(e) => change(() => setNote(e.target.value))} placeholder="Optional" />
        </label>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <form onSubmit={search} className="flex flex-1 gap-2">
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add items: search by name or SKU" />
            <button className="btn-secondary" disabled={pending}>
              Find
            </button>
          </form>
          <div className="flex items-center gap-2 text-sm">
            <span>Add everything with</span>
            <input className="input w-16" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Units in stock or fewer" />
            <span>or fewer in stock</span>
            <button className="btn-secondary" disabled={pending} onClick={addLow}>
              Add
            </button>
          </div>
        </div>
        {found.length > 0 && (
          <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
            {found.map((f) => (
              <li key={f.variantId}>
                <button
                  className="flex w-full justify-between px-3 py-1.5 text-left text-sm hover:bg-stone-50"
                  onClick={() => {
                    add([f]);
                    setFound([]);
                    setQuery('');
                  }}
                >
                  <span>
                    {f.description} {f.sku && <span className="text-stone-400">· {f.sku}</span>}
                  </span>
                  <span className="text-stone-500">{f.costMinor !== null ? `cost ${money(f.costMinor)}` : 'no cost yet'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Item</th>
              <th className="pb-2">Quantity</th>
              <th className="pb-2">Cost each</th>
              <th className="pb-2 text-right">Line total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const q = Number(l.quantity);
              const c = l.cost.trim() ? parseMoney(l.cost) : 0;
              return (
                <tr key={l.variantId} className="border-t border-stone-100">
                  <td className="py-2">
                    {l.description}
                    {l.sku && <div className="text-xs text-stone-500">{l.sku}</div>}
                  </td>
                  <td>
                    <input
                      className="input w-24"
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => change(() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x))))}
                      aria-label={`Quantity of ${l.description}`}
                    />
                  </td>
                  <td>
                    <input
                      className="input w-28"
                      inputMode="decimal"
                      value={l.cost}
                      placeholder="0.00"
                      onChange={(e) => change(() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x))))}
                      aria-label={`Cost of ${l.description}`}
                    />
                  </td>
                  <td className="text-right tabular-nums">{Number.isInteger(q) && c !== null ? money(q * c) : '—'}</td>
                  <td className="text-right">
                    <button className="text-xs text-stone-500 hover:underline" onClick={() => change(() => setLines((ls) => ls.filter((_, j) => j !== i)))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-stone-500">
                  No items yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="flex justify-between border-t border-stone-200 pt-2 font-medium">
          <span>Total</span>
          <span className="tabular-nums">{total === null ? '—' : money(total)}</span>
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {notice && <p className="text-sm text-teal-700">{notice}</p>}
        <button className="btn-secondary" disabled={pending || !dirty} onClick={() => save()}>
          {dirty ? 'Save draft' : 'Saved'}
        </button>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Place the order</h2>
        {canEmail && supplier?.email ? (
          <>
            <textarea
              className="input min-h-20"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`Message to ${supplier.contactName ?? supplier.name} (optional)`}
            />
            <div className="flex flex-wrap gap-2">
              <button className="btn" disabled={pending || !lines.length} onClick={() => save(() => placeOrder(tenantId, order.id, true, message))}>
                Email to {supplier.email}
              </button>
              <button className="btn-secondary" disabled={pending || !lines.length} onClick={() => save(() => placeOrder(tenantId, order.id, false, ''))}>
                Mark as placed (sent another way)
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-stone-600">
              {canEmail ? `Add an email for ${supplier?.name ?? 'this supplier'} to send orders from here.` : 'Email isn’t set up, so send the order yourself.'} Then mark it as placed so it
              can be received.
            </p>
            <button className="btn" disabled={pending || !lines.length} onClick={() => save(() => placeOrder(tenantId, order.id, false, ''))}>
              Mark as placed
            </button>
          </>
        )}
        <button className="block text-sm text-red-700 hover:underline" disabled={pending} onClick={() => startTransition(async () => {
          const r = await finishOrder(tenantId, order.id, 'cancel');
          if (!r.ok) setError(r.error);
          else router.refresh();
        })}>
          Cancel this draft
        </button>
      </section>
    </div>
  );
}

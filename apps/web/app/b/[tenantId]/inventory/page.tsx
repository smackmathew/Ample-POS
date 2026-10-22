import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { can, variantLabel, type CurrentTenant, type Location, type Movement, type StockLevel } from '@/lib/types';
import { stockOperation } from '../catalog-actions';

const REASONS: Record<string, string> = {
  receive: 'Received',
  sale: 'Sale',
  return: 'Return',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  adjustment: 'Adjustment',
  count_adjustment: 'Count',
};

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ location?: string; search?: string }>;
}) {
  const { tenantId } = await params;
  const sp = await searchParams;
  const [current, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
  ]);
  if (!locations.length) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-semibold">Stock levels</h1>
        <p className="mt-2 text-stone-600">
          Add a <Link href={`/b/${tenantId}/locations`} className="underline">location</Link> to start tracking stock.
        </p>
      </div>
    );
  }
  const location = locations.find((l) => l.id === sp.location) ?? locations[0]!;
  const qs = new URLSearchParams({ locationId: location.id, limit: '500', ...(sp.search ? { search: sp.search } : {}) });
  const [{ levels }, { movements }] = await Promise.all([
    api<{ levels: StockLevel[] }>(`/inventory/levels?${qs}`, { tenantId }),
    api<{ movements: Movement[] }>(`/inventory/movements?locationId=${location.id}&limit=15`, { tenantId }),
  ]);
  const canAdjust = can(current.membership.permissions, 'inventory.adjust');
  const others = locations.filter((l) => l.id !== location.id);

  const variantSelect = (
    <select name="variantId" required className="input sm:col-span-2">
      {levels.map((l) => (
        <option key={l.variantId} value={l.variantId}>
          {variantLabel(l.productName, l.variantName)} ({l.onHand} on hand)
        </option>
      ))}
    </select>
  );
  // A fresh key per form and render: a double-submitted form is only applied once.
  const hidden = () => (
    <>
      <input type="hidden" name="locationId" value={location.id} />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
    </>
  );

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Stock levels</h1>
      <form className="flex flex-wrap gap-2">
        <select name="location" defaultValue={location.id} className="input w-48">
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input name="search" defaultValue={sp.search ?? ''} placeholder="Search products" className="input max-w-xs" />
        <button className="btn-secondary">Show</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Item</th>
              <th className="pb-2">SKU</th>
              <th className="pb-2 text-right">On hand</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.variantId} className="border-t border-stone-100">
                <td className="py-2">{variantLabel(l.productName, l.variantName)}</td>
                <td className="text-stone-500">{l.sku ?? '—'}</td>
                <td className={`text-right font-medium tabular-nums ${l.onHand < 0 ? 'text-red-700' : ''}`}>{l.onHand}</td>
              </tr>
            ))}
            {levels.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-stone-500">
                  No tracked products. Add some under <Link href={`/b/${tenantId}/catalog`} className="underline">Products</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canAdjust && levels.length > 0 && (
        <section className="grid gap-4 lg:grid-cols-3">
          <ActionForm action={stockOperation.bind(null, tenantId, 'receive')} className="card grid gap-2 sm:grid-cols-2">
            <h2 className="font-medium sm:col-span-2">Receive stock</h2>
            {hidden()}
            {variantSelect}
            <input name="quantity" type="number" min={1} placeholder="Quantity" required className="input" />
            <input name="note" placeholder="Note (PO, supplier…)" className="input" />
            <button className="btn sm:justify-self-start">Receive</button>
          </ActionForm>
          <ActionForm action={stockOperation.bind(null, tenantId, 'adjust')} className="card grid gap-2 sm:grid-cols-2">
            <h2 className="font-medium sm:col-span-2">Adjust stock</h2>
            {hidden()}
            {variantSelect}
            <input name="quantity" type="number" placeholder="+/- quantity" required className="input" />
            <input name="note" placeholder="Reason (required)" required className="input" />
            <button className="btn sm:justify-self-start">Adjust</button>
          </ActionForm>
          {others.length > 0 && (
            <ActionForm action={stockOperation.bind(null, tenantId, 'transfer')} className="card grid gap-2 sm:grid-cols-2">
              <h2 className="font-medium sm:col-span-2">Transfer out</h2>
              {hidden()}
              {variantSelect}
              <input name="quantity" type="number" min={1} placeholder="Quantity" required className="input" />
              <select name="toLocationId" className="input">
                {others.map((l) => (
                  <option key={l.id} value={l.id}>
                    To {l.name}
                  </option>
                ))}
              </select>
              <button className="btn sm:justify-self-start">Transfer</button>
            </ActionForm>
          )}
        </section>
      )}

      <section>
        <h2 className="font-medium">Recent movements at {location.name}</h2>
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-t border-stone-100 first:border-0">
                  <td className="py-2 whitespace-nowrap text-stone-500">{new Date(m.occurredAt).toLocaleString()}</td>
                  <td>{variantLabel(m.productName, m.variantName)}</td>
                  <td>{REASONS[m.reason] ?? m.reason}</td>
                  <td className={`text-right tabular-nums ${m.quantityDelta < 0 ? 'text-red-700' : 'text-teal-700'}`}>
                    {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
                  </td>
                  <td className="pl-4 text-stone-500">{m.note ?? ''}</td>
                </tr>
              ))}
              {movements.length === 0 && (
                <tr>
                  <td className="py-2 text-stone-500">No movements yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

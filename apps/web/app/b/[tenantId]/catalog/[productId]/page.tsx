import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney, moneyInput } from '@/lib/money';
import { can, type CurrentTenant, type Product } from '@/lib/types';
import { addVariant, updateProduct, updateVariant } from '../../catalog-actions';

export default async function ProductPage({ params }: { params: Promise<{ tenantId: string; productId: string }> }) {
  const { tenantId, productId } = await params;
  const [current, product] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Product>(`/catalog/products/${productId}`, { tenantId }),
  ]);
  const currency = current.tenant.currency;
  const canManage = can(current.membership.permissions, 'catalog.manage');

  return (
    <div className="max-w-5xl space-y-6">
      <Link href={`/b/${tenantId}/catalog`} className="text-sm text-stone-500 hover:underline">
        ← Products
      </Link>
      <h1 className="text-2xl font-semibold">{product.name}</h1>

      {canManage ? (
        <ActionForm key={product.id} action={updateProduct.bind(null, tenantId, product.id, product.version)} className="card grid gap-3 sm:grid-cols-3">
          <input name="name" defaultValue={product.name} required className="input" />
          <input name="category" defaultValue={product.category ?? ''} placeholder="Category" className="input" />
          <select name="status" defaultValue={product.status} className="input">
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
          <textarea name="description" defaultValue={product.description ?? ''} placeholder="Description" rows={2} className="input sm:col-span-3" />
          <button className="btn sm:justify-self-start">Save product</button>
        </ActionForm>
      ) : (
        product.category && <p className="text-stone-600">{product.category}</p>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Variants</h2>
        {product.variants.map((v) =>
          canManage ? (
            <ActionForm
              key={v.id}
              action={updateVariant.bind(null, tenantId, v.id, v.version)}
              className={`card grid gap-2 sm:grid-cols-6 ${v.status === 'archived' ? 'opacity-60' : ''}`}
            >
              <label className="text-xs text-stone-500">
                Name
                <input name="name" defaultValue={v.name} required className="input mt-1" />
              </label>
              <label className="text-xs text-stone-500">
                SKU
                <input name="sku" defaultValue={v.sku ?? ''} className="input mt-1" />
              </label>
              <label className="text-xs text-stone-500">
                Price
                <input name="price" defaultValue={moneyInput(v.priceMinor)} inputMode="decimal" required className="input mt-1" />
              </label>
              <label className="text-xs text-stone-500">
                Cost
                <input name="cost" defaultValue={moneyInput(v.costMinor)} inputMode="decimal" className="input mt-1" />
              </label>
              <label className="text-xs text-stone-500 sm:col-span-2">
                Barcodes
                <input name="barcodes" defaultValue={v.barcodes.join(', ')} className="input mt-1" />
              </label>
              <select name="status" defaultValue={v.status} className="input">
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
              <span className="self-center text-xs text-stone-500">{v.trackInventory ? 'Stock tracked' : 'Stock not tracked'}</span>
              <button className="btn-secondary sm:col-start-6">Save</button>
            </ActionForm>
          ) : (
            <div key={v.id} className="card flex justify-between text-sm">
              <span>
                {v.name} {v.sku && <span className="text-stone-500">· {v.sku}</span>}
              </span>
              <span>{formatMoney(v.priceMinor, currency)}</span>
            </div>
          ),
        )}
      </section>

      {canManage && (
        <ActionForm action={addVariant.bind(null, tenantId, product.id)} className="card grid gap-2 sm:grid-cols-5">
          <input name="name" placeholder="New variant name" required className="input" />
          <input name="sku" placeholder="SKU" className="input" />
          <input name="price" placeholder="Price" inputMode="decimal" required className="input" />
          <input name="barcodes" placeholder="Barcodes" className="input" />
          <button className="btn">Add variant</button>
        </ActionForm>
      )}
    </div>
  );
}

import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { can, type CurrentTenant, type Product } from '@/lib/types';
import { createProduct } from '../catalog-actions';

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ search?: string; status?: string }>;
}) {
  const { tenantId } = await params;
  const { search = '', status = 'active' } = await searchParams;
  const qs = new URLSearchParams({ status, limit: '200', ...(search ? { search } : {}) });
  const [current, { products }] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<{ products: Product[] }>(`/catalog/products?${qs}`, { tenantId }),
  ]);
  const currency = current.tenant.currency;
  const canManage = can(current.membership.permissions, 'catalog.manage');

  const priceRange = (p: Product) => {
    const prices = p.variants.filter((v) => v.status === 'active').map((v) => v.priceMinor);
    if (!prices.length) return '—';
    const [lo, hi] = [Math.min(...prices), Math.max(...prices)];
    return lo === hi ? formatMoney(lo, currency) : `${formatMoney(lo, currency)} – ${formatMoney(hi, currency)}`;
  };

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Products</h1>
      <form className="flex gap-2">
        <input name="search" defaultValue={search} placeholder="Search name, SKU or barcode" className="input max-w-sm" />
        <select name="status" defaultValue={status} className="input w-36">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
        <button className="btn-secondary">Search</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Product</th>
              <th className="pb-2">Category</th>
              <th className="pb-2">Variants</th>
              <th className="pb-2">Price</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-stone-100">
                <td className="py-2">
                  <Link href={`/b/${tenantId}/catalog/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.status === 'archived' && <span className="ml-2 text-xs text-stone-400">archived</span>}
                </td>
                <td>{p.category ?? '—'}</td>
                <td>{p.variants.length}</td>
                <td>{priceRange(p)}</td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-stone-500">
                  {search ? 'No products match.' : 'No products yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <ActionForm action={createProduct.bind(null, tenantId)} className="card space-y-3">
          <h2 className="font-medium">New product</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="name" placeholder="Product name" required className="input" />
            <input name="category" placeholder="Category (optional)" className="input" />
          </div>
          <p className="text-xs text-stone-500">
            One row per variant (size, color…). For a simple product fill in only the first row and leave its name blank.
          </p>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-4">
              <input name={`v${i}.name`} placeholder={i === 0 ? 'Variant (optional)' : 'Variant'} className="input" />
              <input name={`v${i}.sku`} placeholder="SKU" className="input" />
              <input name={`v${i}.price`} placeholder="Price, e.g. 12.50" inputMode="decimal" required={i === 0} className="input" />
              <input name={`v${i}.barcodes`} placeholder="Barcodes (comma separated)" className="input" />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="trackInventory" value="off" /> Don’t track stock (services, gift wrap…)
          </label>
          <button className="btn">Create product</button>
        </ActionForm>
      )}
    </div>
  );
}

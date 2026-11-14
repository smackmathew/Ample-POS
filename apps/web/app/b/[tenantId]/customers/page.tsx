import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { formatDate, homeTimeZone } from '@/lib/time';
import type { CurrentTenant, CustomerSummary, Location } from '@/lib/types';
import { addCustomer } from '../customer-actions';

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ search?: string; deleted?: string }>;
}) {
  const { tenantId } = await params;
  const { search = '', deleted } = await searchParams;
  const [current, locations, customers] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
    api<CustomerSummary[]>(`/customers?limit=100&search=${encodeURIComponent(search)}`, { tenantId }),
  ]);
  const tz = homeTimeZone(locations);
  const money = (n: number) => formatMoney(n, current.tenant.currency);

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Customers</h1>
      {deleted && <p className="card border-teal-200 bg-teal-50 text-sm">Customer deleted. Their past sales are kept without a name.</p>}

      <details className="card">
        <summary className="cursor-pointer font-medium">Add a customer</summary>
        <ActionForm action={addCustomer.bind(null, tenantId)} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input name="name" placeholder="Name" required className="input" />
          <input name="email" type="email" placeholder="Email (for receipts)" className="input" />
          <input name="phone" type="tel" placeholder="Phone" className="input" />
          <input name="note" placeholder="Note (optional)" className="input" />
          <div>
            <button className="btn">Add customer</button>
          </div>
        </ActionForm>
      </details>

      <section className="space-y-2">
        <form className="flex gap-2">
          <input name="search" defaultValue={search} placeholder="Search by name, email or phone" className="input max-w-sm" />
          <button className="btn-secondary">Search</button>
          {search && (
            <Link href={`/b/${tenantId}/customers`} className="self-center text-sm text-stone-500 hover:underline">
              Clear
            </Link>
          )}
        </form>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="pb-2">Name</th>
                <th className="pb-2">Contact</th>
                <th className="pb-2 text-right">Visits</th>
                <th className="pb-2 text-right">Spent</th>
                <th className="pb-2 text-right">Last visit</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-stone-100">
                  <td className="py-2">
                    <Link href={`/b/${tenantId}/customers/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="text-stone-600">{[c.email, c.phone].filter(Boolean).join(' · ') || <span className="text-stone-400">—</span>}</td>
                  <td className="text-right tabular-nums">{c.visits}</td>
                  <td className="text-right tabular-nums">{money(c.spentMinor)}</td>
                  <td className="text-right text-stone-500">{c.lastVisitAt ? formatDate(c.lastVisitAt, tz) : '—'}</td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-stone-500">
                    {search ? `No customers match “${search}”.` : 'No customers yet. Add them here or at the register.'}
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

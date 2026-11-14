import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { Supplier } from '@/lib/types';
import { addSupplier, archiveSupplier, updateSupplier } from '../../purchasing-actions';

export default async function SuppliersPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ archived?: string }> }) {
  const { tenantId } = await params;
  const { archived } = await searchParams;
  const suppliers = await api<Supplier[]>(`/suppliers${archived ? '?archived=true' : ''}`, { tenantId });

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Suppliers</h1>

      <details className="card" open={suppliers.length === 0}>
        <summary className="cursor-pointer font-medium">Add a supplier</summary>
        <ActionForm action={addSupplier.bind(null, tenantId)} className="mt-3 grid gap-3 sm:grid-cols-2">
          <SupplierFields />
          <div>
            <button className="btn">Add supplier</button>
          </div>
        </ActionForm>
      </details>

      <div className="space-y-2">
        {suppliers.map((s) => (
          <details key={s.id} className={`card ${s.archivedAt ? 'opacity-60' : ''}`}>
            <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {s.name}
                {s.archivedAt && <span className="ml-2 text-xs text-stone-500">archived</span>}
              </span>
              <span className="text-sm text-stone-500">
                {[s.contactName, s.email, s.phone].filter(Boolean).join(' · ') || 'No contact details'}
                {s.openOrders > 0 && ` · ${s.openOrders} open order${s.openOrders === 1 ? '' : 's'}`}
              </span>
            </summary>
            <ActionForm key={JSON.stringify(s)} action={updateSupplier.bind(null, tenantId, s.id)} className="mt-3 grid gap-3 sm:grid-cols-2">
              <SupplierFields supplier={s} />
              <div className="flex gap-2">
                <button className="btn-secondary">Save</button>
              </div>
            </ActionForm>
            <form action={archiveSupplier.bind(null, tenantId, s.id, !s.archivedAt)} className="mt-2">
              <button className="text-sm text-stone-500 hover:underline">{s.archivedAt ? 'Restore' : 'Archive'}</button>
            </form>
          </details>
        ))}
      </div>
      <a href={`/b/${tenantId}/purchasing/suppliers${archived ? '' : '?archived=1'}`} className="text-sm text-stone-500 hover:underline">
        {archived ? 'Hide archived suppliers' : 'Show archived suppliers'}
      </a>
    </div>
  );
}

function SupplierFields({ supplier }: { supplier?: Supplier }) {
  return (
    <>
      <input name="name" placeholder="Name" defaultValue={supplier?.name} required className="input" />
      <input name="contactName" placeholder="Contact person" defaultValue={supplier?.contactName ?? ''} className="input" />
      <input name="email" type="email" placeholder="Email (for sending orders)" defaultValue={supplier?.email ?? ''} className="input" />
      <input name="phone" type="tel" placeholder="Phone" defaultValue={supplier?.phone ?? ''} className="input" />
      <input name="notes" placeholder="Notes, e.g. account number, delivery days" defaultValue={supplier?.notes ?? ''} className="input sm:col-span-2" />
    </>
  );
}

import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type Location, type LocationAddress } from '@/lib/types';
import { formatPercent } from '@/lib/pricing';
import { createLocation, setLocationAddress, setLocationArchived } from '../actions';

export default async function LocationsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Location[]>('/locations?includeArchived=true', { tenantId }),
  ]);
  const canManage = can(current.membership.permissions, 'locations.manage');

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Locations</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
        <thead className="text-left text-stone-500">
          <tr>
            <th className="pb-2">Name</th>
            <th className="pb-2">Type</th>
            <th className="pb-2">Time zone</th>
            <th className="pb-2">Sales tax</th>
            <th className="pb-2">Address</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => (
            <tr key={l.id} className={`border-t border-stone-100 ${l.archivedAt ? 'text-stone-400' : ''}`}>
              <td className="py-2">{l.name}</td>
              <td className="capitalize">{l.kind}</td>
              <td>{l.timezone}</td>
              <td>{formatPercent(l.taxRateBps)}</td>
              <td className="py-2">
                {l.address ? <span className="whitespace-pre-line">{formatAddress(l.address)}</span> : <span className="text-stone-400">None</span>}
                {canManage && !l.archivedAt && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-stone-500 hover:underline">{l.address ? 'Edit' : 'Add address'}</summary>
                    <ActionForm action={setLocationAddress.bind(null, tenantId, l.id)} className="mt-2 grid gap-2">
                      <AddressFields value={l.address} />
                      <button className="btn-secondary justify-self-start px-3 py-1 text-xs">Save address</button>
                    </ActionForm>
                  </details>
                )}
              </td>
              <td className="text-right">
                {canManage && (
                  <form action={setLocationArchived.bind(null, tenantId, l.id, !l.archivedAt)}>
                    <button className="text-xs text-stone-500 hover:underline">{l.archivedAt ? 'Restore' : 'Archive'}</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {locations.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-stone-500">No locations yet.</td>
            </tr>
          )}
        </tbody>
        </table>
      </div>

      {canManage && (
        <ActionForm action={createLocation.bind(null, tenantId)} className="card grid gap-3 sm:grid-cols-5">
          <input name="name" placeholder="Name" required className="input sm:col-span-2" />
          <select name="kind" className="input">
            <option value="store">Store</option>
            <option value="warehouse">Warehouse</option>
            <option value="office">Office</option>
          </select>
          <input name="timezone" placeholder="America/Chicago" required className="input" />
          <input name="taxRate" placeholder="Sales tax %, e.g. 8.25" inputMode="decimal" className="input" />
          <fieldset className="grid gap-2 sm:col-span-5 sm:grid-cols-2">
            <legend className="mb-1 text-xs text-stone-500">Street address (optional; card readers need one)</legend>
            <AddressFields value={null} />
          </fieldset>
          <button className="btn sm:col-span-5 sm:justify-self-start">Add location</button>
        </ActionForm>
      )}
    </div>
  );
}

function formatAddress(a: LocationAddress): string {
  return [a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join('\n');
}

function AddressFields({ value }: { value: LocationAddress | null }) {
  return (
    <>
      <input name="line1" defaultValue={value?.line1} placeholder="Street address" className="input" />
      <input name="line2" defaultValue={value?.line2} placeholder="Suite, unit (optional)" className="input" />
      <input name="city" defaultValue={value?.city} placeholder="City" className="input" />
      <input name="state" defaultValue={value?.state} placeholder="State / region" className="input" />
      <input name="postalCode" defaultValue={value?.postalCode} placeholder="ZIP / postal code" className="input" />
      <input name="country" defaultValue={value?.country ?? 'US'} placeholder="Country code, e.g. US" maxLength={2} className="input uppercase" />
    </>
  );
}

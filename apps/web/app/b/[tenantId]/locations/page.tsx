import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type Location } from '@/lib/types';
import { formatPercent } from '@/lib/pricing';
import { createLocation, setLocationArchived } from '../actions';

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
              <td colSpan={5} className="py-4 text-stone-500">No locations yet.</td>
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
          <button className="btn sm:col-span-5 sm:justify-self-start">Add location</button>
        </ActionForm>
      )}
    </div>
  );
}

import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { Device, Location } from '@/lib/types';
import { registerDevice, revokeDevice } from '../actions';

export default async function DevicesPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [devices, locations] = await Promise.all([
    api<Device[]>('/devices', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
  ]);
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Devices</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
        <thead className="text-left text-stone-500">
          <tr>
            <th className="pb-2">Name</th>
            <th className="pb-2">Type</th>
            <th className="pb-2">Location</th>
            <th className="pb-2">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="border-t border-stone-100">
              <td className="py-2">{d.name}</td>
              <td className="capitalize">{d.kind}</td>
              <td>{locationName.get(d.locationId) ?? '—'}</td>
              <td className="capitalize">{d.status}</td>
              <td className="text-right">
                {d.status === 'active' && (
                  <form action={revokeDevice.bind(null, tenantId, d.id)}>
                    <button className="text-xs text-red-700 hover:underline">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {devices.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-stone-500">No devices registered.</td>
            </tr>
          )}
        </tbody>
        </table>
      </div>

      {locations.length === 0 ? (
        <p className="text-sm text-stone-600">Add a location before registering devices.</p>
      ) : (
        <ActionForm
          action={registerDevice.bind(null, tenantId)}
          className="card grid gap-3 sm:grid-cols-3"
          secretLabel="Pair the device now. This code will not be shown again."
        >
          <input name="name" placeholder="Register 1" required className="input" />
          <select name="kind" className="input">
            <option value="register">Register</option>
            <option value="handheld">Handheld</option>
            <option value="kiosk">Kiosk</option>
          </select>
          <select name="locationId" className="input">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn sm:col-span-3 sm:justify-self-start">Register device</button>
        </ActionForm>
      )}
    </div>
  );
}

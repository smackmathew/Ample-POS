import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { CountSummary, Location } from '@/lib/types';
import { startCount } from '../../catalog-actions';

const STATUS_STYLE: Record<CountSummary['status'], string> = {
  open: 'bg-sky-50 text-sky-800',
  submitted: 'bg-amber-50 text-amber-800',
  approved: 'bg-teal-50 text-teal-800',
  cancelled: 'bg-stone-100 text-stone-500',
};

export default async function CountsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [counts, locations] = await Promise.all([
    api<CountSummary[]>('/inventory/counts', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
  ]);

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Counts</h1>
      {locations.length > 0 && (
        <ActionForm action={startCount.bind(null, tenantId)} className="card flex flex-wrap gap-2">
          <input name="name" placeholder="Count name, e.g. Weekly – back room" required className="input max-w-xs" />
          <select name="locationId" className="input w-48">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn">Start count</button>
        </ActionForm>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Count</th>
              <th className="pb-2">Location</th>
              <th className="pb-2">Started</th>
              <th className="pb-2">Entries</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => (
              <tr key={c.id} className="border-t border-stone-100">
                <td className="py-2">
                  <Link href={`/b/${tenantId}/inventory/counts/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td>{c.locationName}</td>
                <td className="text-stone-500">{new Date(c.startedAt).toLocaleString()}</td>
                <td>{c.entryCount}</td>
                <td>
                  <span className={`rounded px-2 py-0.5 text-xs capitalize ${STATUS_STYLE[c.status]}`}>{c.status}</span>
                </td>
              </tr>
            ))}
            {counts.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-stone-500">No counts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

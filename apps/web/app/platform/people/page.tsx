import Link from 'next/link';
import { api } from '@/lib/api';
import { utc, type Person } from '@/lib/platform';
import { Flags } from './flags';

const FILTERS = [
  ['all', 'Everyone'],
  ['unconfirmed', 'Email not confirmed'],
  ['locked', 'Locked out'],
  ['disabled', 'Turned off'],
] as const;

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ search?: string; status?: string }> }) {
  const { search = '', status = 'all' } = await searchParams;
  const filter = FILTERS.some(([k]) => k === status) ? status : 'all';
  const people = await api<Person[]>(`/platform/users?status=${filter}&limit=100&search=${encodeURIComponent(search)}`);

  return (
    <div className="max-w-7xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">People</h1>
        <p className="text-sm text-stone-600">Everyone with an Ample POS account. Open someone to help them sign in, or to turn their account off.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 text-sm">
          {FILTERS.map(([key, label]) => (
            <Link
              key={key}
              href={`/platform/people?status=${key}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
              className={`rounded-lg px-3 py-1 ${filter === key ? 'bg-brand text-white' : 'bg-white hover:bg-stone-100'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="flex gap-2">
          <input type="hidden" name="status" value={filter} />
          <input name="search" defaultValue={search} placeholder="Name, email or business" className="input w-64" />
          <button className="btn-secondary">Search</button>
        </form>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2">Person</th>
              <th className="px-4 py-2">Businesses</th>
              <th className="px-4 py-2">Sign-in</th>
              <th className="px-4 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className="border-t border-stone-100 align-top">
                <td className="px-4 py-2">
                  <Link href={`/platform/people/${p.id}`} className="font-medium hover:underline">
                    {p.name ?? p.email ?? 'No name'}
                  </Link>
                  <div className="text-xs text-stone-500">{p.email}</div>
                </td>
                <td className="px-4 py-2 text-stone-600">{p.businesses.join(', ') || '—'}</td>
                <td className="px-4 py-2">
                  <Flags p={p} />
                </td>
                <td className="px-4 py-2 text-stone-500">{utc(p.lastSeenAt, false)}</td>
              </tr>
            ))}
            {people.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-stone-500">
                  Nobody matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

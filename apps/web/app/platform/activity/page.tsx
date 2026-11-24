import Link from 'next/link';
import { api } from '@/lib/api';
import { utc, type ActivityEntry } from '@/lib/platform';

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ tenantId?: string; before?: string }> }) {
  const { tenantId, before } = await searchParams;
  const qs = new URLSearchParams({ limit: '100', ...(tenantId ? { tenantId } : {}), ...(before ? { before } : {}) });
  const { entries, nextBefore } = await api<{ entries: ActivityEntry[]; nextBefore: number | null }>(`/platform/activity?${qs}`);
  const page = (b?: number) => `/platform/activity?${new URLSearchParams({ ...(tenantId ? { tenantId } : {}), ...(b ? { before: String(b) } : {}) })}`;

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Activity</h1>
        {tenantId && (
          <Link href="/platform/activity" className="text-sm text-stone-500 hover:underline">
            All companies
          </Link>
        )}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Company</th>
              <th className="px-4 py-2">What</th>
              <th className="px-4 py-2">Who</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-stone-100 align-top">
                <td className="whitespace-nowrap px-4 py-2 text-stone-500">{utc(e.createdAt)}</td>
                <td className="px-4 py-2">
                  <Link href={`/platform/companies/${e.tenantId}`} className="hover:underline">
                    {e.tenantName}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <code className="text-xs">{e.action}</code>
                  {e.targetId && <span className="text-stone-500"> · {e.targetType} {e.targetId.slice(0, 18)}</span>}
                  {Object.keys(e.data).length > 0 && <div className="max-w-md truncate text-xs text-stone-500">{JSON.stringify(e.data)}</div>}
                </td>
                <td className="px-4 py-2">{e.actor ?? e.actorEmail ?? <span className="text-stone-400">system</span>}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-stone-500">
                  Nothing yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex gap-4 text-sm">
        {before && (
          <Link href={page()} className="hover:underline">
            Newest
          </Link>
        )}
        {nextBefore && (
          <Link href={page(nextBefore)} className="hover:underline">
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}

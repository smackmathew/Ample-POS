import Link from 'next/link';
import { api } from '@/lib/api';
import { utc, type AdminLogEntry } from '@/lib/platform';

export default async function AdminLogPage() {
  const entries = await api<AdminLogEntry[]>('/platform/audit?limit=200');
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">Admin log</h1>
      <p className="text-stone-600">Every change made from this dashboard.</p>
      <div className="card space-y-2 text-sm">
        {entries.map((e) => (
          <div key={e.id} className="flex flex-wrap justify-between gap-2 border-t border-stone-100 pt-2 first:border-0 first:pt-0">
            <span>
              <code className="text-xs">{e.action}</code>
              {e.tenantId && (
                <>
                  {' · '}
                  <Link href={`/platform/companies/${e.tenantId}`} className="hover:underline">
                    {e.tenantName}
                  </Link>
                </>
              )}
              <span className="text-stone-500"> · {e.actorEmail}</span>
              <div className="text-xs text-stone-500">{JSON.stringify(e.data)}</div>
            </span>
            <span className="text-xs text-stone-500">{utc(e.createdAt)}</span>
          </div>
        ))}
        {entries.length === 0 && <p className="text-stone-500">No changes yet.</p>}
      </div>
    </div>
  );
}

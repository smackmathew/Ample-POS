import Link from 'next/link';
import { api } from '@/lib/api';
import type { AuditEntry } from '@/lib/types';

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { tenantId } = await params;
  const { before } = await searchParams;
  const qs = before && /^\d+$/.test(before) ? `?before=${before}` : '';
  const { entries, nextBefore } = await api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/audit${qs}`, { tenantId });

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
        <thead className="text-left text-stone-500">
          <tr>
            <th className="pb-2">When</th>
            <th className="pb-2">Who</th>
            <th className="pb-2">Action</th>
            <th className="pb-2">Details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-stone-100 align-top">
              <td className="py-2 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.actor?.displayName ?? e.actor?.email ?? 'System'}</td>
              <td className="font-mono text-xs">{e.action}</td>
              <td className="font-mono text-xs break-all text-stone-500">{JSON.stringify(e.data)}</td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      {nextBefore && (
        <Link href={`?before=${nextBefore}`} className="btn-secondary">
          Older entries
        </Link>
      )}
    </div>
  );
}

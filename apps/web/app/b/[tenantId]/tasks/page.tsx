import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDay, formatTime } from '@/lib/time';
import { can, type CurrentTenant, type Location } from '@/lib/types';
import { toggleTask } from '../workforce-actions';

interface TodayList {
  runId: string;
  runDate: string;
  overdue: boolean;
  checklist: { id: string; title: string };
  items: { id: string; label: string; completion: { by: string; completedAt: string; note: string | null } | null }[];
  done: number;
  total: number;
}

export default async function TasksPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ location?: string }> }) {
  const { tenantId } = await params;
  const { location } = await searchParams;
  const [current, locations] = await Promise.all([api<CurrentTenant>('/tenant', { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const loc = locations.find((l) => l.id === location) ?? locations[0];
  const { date, lists } = await api<{ date: string; lists: TodayList[] }>(`/tasks/today${loc ? `?locationId=${loc.id}` : ''}`, { tenantId });

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Today’s tasks</h1>
        {can(current.membership.permissions, 'tasks.manage') && (
          <Link href={`/b/${tenantId}/tasks/manage`} className="text-sm text-stone-600 hover:underline">
            Edit checklists
          </Link>
        )}
      </div>
      {locations.length > 1 && (
        <form className="flex gap-2">
          <select name="location" defaultValue={loc?.id} className="input w-48">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary">Show</button>
        </form>
      )}
      <p className="text-sm text-stone-500">{formatDay(date)}</p>
      {lists.map((l) => (
        <section key={l.runId} className="card space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-medium">
              {l.checklist.title}
              {l.overdue && <span className="ml-2 text-xs text-red-700">due {formatDay(l.runDate)}</span>}
            </h2>
            <span className={`text-sm ${l.done === l.total ? 'text-teal-700' : 'text-stone-500'}`}>
              {l.done}/{l.total}
            </span>
          </div>
          <ul className="space-y-1">
            {l.items.map((i) => (
              <li key={i.id}>
                <form action={toggleTask.bind(null, tenantId, l.runId, i.id, Boolean(i.completion))}>
                  <button className="flex w-full items-start gap-3 rounded px-1 py-1 text-left hover:bg-stone-50">
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${i.completion ? 'border-teal-700 bg-teal-700 text-white' : 'border-stone-300'}`}
                    >
                      {i.completion ? '✓' : ''}
                    </span>
                    <span>
                      <span className={i.completion ? 'text-stone-500 line-through' : ''}>{i.label}</span>
                      {i.completion && (
                        <span className="block text-xs text-stone-400">
                          {i.completion.by} · {formatTime(i.completion.completedAt, loc?.timezone ?? 'UTC')}
                        </span>
                      )}
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {lists.length === 0 && <p className="text-stone-500">Nothing on your list today.</p>}
    </div>
  );
}

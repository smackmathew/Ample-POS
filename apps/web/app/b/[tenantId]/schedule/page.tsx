import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { addDays, formatDay, formatTime, localDate, mondayOf, zonedToUtc } from '@/lib/time';
import { can, type CurrentTenant, type Location, type Member } from '@/lib/types';
import { addShift, deleteShift, publishWeek } from '../workforce-actions';

interface Shift {
  id: string;
  locationId: string;
  locationName: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  startsAt: string;
  endsAt: string;
  position: string | null;
  status: 'draft' | 'published';
}

export default async function SchedulePage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ week?: string }> }) {
  const { tenantId } = await params;
  const { week } = await searchParams;
  const [current, locations] = await Promise.all([api<CurrentTenant>('/tenant', { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const tz = locations[0]?.timezone ?? 'UTC';
  const monday = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : localDate(new Date(), tz));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const from = zonedToUtc(`${monday}T00:00`, tz).toISOString();
  const to = zonedToUtc(`${addDays(monday, 7)}T00:00`, tz).toISOString();
  const canManage = can(current.membership.permissions, 'scheduling.manage');
  const [shifts, members] = await Promise.all([
    api<Shift[]>(`/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { tenantId }),
    canManage ? api<Member[]>('/members', { tenantId }) : Promise.resolve([] as Member[]),
  ]);
  const timezones = Object.fromEntries(locations.map((l) => [l.id, l.timezone]));
  const rows = [
    ...new Map(shifts.filter((s) => s.userId).map((s) => [s.userId!, s.userName ?? s.userEmail ?? 'Unknown'])),
    ...(shifts.some((s) => !s.userId) ? [[null, 'Open shifts'] as [null, string]] : []),
  ];
  const drafts = shifts.filter((s) => s.status === 'draft').length;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Schedule</h1>
        <div className="flex items-center gap-2 text-sm">
          <Link className="btn-secondary" href={`?week=${addDays(monday, -7)}`}>
            ← Previous
          </Link>
          <span className="font-medium">Week of {formatDay(monday)}</span>
          <Link className="btn-secondary" href={`?week=${addDays(monday, 7)}`}>
            Next →
          </Link>
        </div>
      </div>
      {canManage && drafts > 0 && (
        <ActionForm action={publishWeek.bind(null, tenantId, from, to)} className="card flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50">
          <span className="text-sm">{drafts === 1 ? '1 draft shift isn’t' : `${drafts} draft shifts aren’t`} visible to your team yet.</span>
          <button className="btn">Publish this week</button>
        </ActionForm>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="w-40 pb-2">Person</th>
              {days.map((d) => (
                <th key={d} className="pb-2">
                  {formatDay(d).split(',')[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([userId, label]) => (
              <tr key={userId ?? 'open'} className="border-t border-stone-100 align-top">
                <td className="py-2 font-medium">{label}</td>
                {days.map((d) => (
                  <td key={d} className="space-y-1 py-2 pr-1">
                    {shifts
                      .filter((s) => s.userId === userId && localDate(new Date(s.startsAt), timezones[s.locationId] ?? tz) === d)
                      .map((s) => (
                        <div key={s.id} className={`rounded border px-2 py-1 text-xs ${s.status === 'draft' ? 'border-dashed border-amber-400 bg-amber-50' : 'border-teal-200 bg-teal-50'}`}>
                          <div className="font-medium">
                            {formatTime(s.startsAt, timezones[s.locationId] ?? tz)}–{formatTime(s.endsAt, timezones[s.locationId] ?? tz)}
                          </div>
                          <div className="text-stone-600">
                            {s.position ?? ''} {locations.length > 1 ? `· ${s.locationName}` : ''}
                          </div>
                          {canManage && (
                            <form action={deleteShift.bind(null, tenantId, s.id)}>
                              <button className="text-red-700 hover:underline">Remove</button>
                            </form>
                          )}
                        </div>
                      ))}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-4 text-stone-500">
                  {canManage ? 'No shifts this week yet.' : 'No published shifts this week.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <ActionForm action={addShift.bind(null, tenantId, timezones)} className="card grid gap-2 sm:grid-cols-7">
          <h2 className="font-medium sm:col-span-7">Add a shift</h2>
          <select name="userId" className="input sm:col-span-2">
            <option value="">Open shift</option>
            {members
              .filter((m) => m.status === 'active')
              .map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.displayName ?? m.user.email}
                </option>
              ))}
          </select>
          <input name="date" type="date" defaultValue={monday} required className="input" />
          <input name="start" type="time" defaultValue="09:00" required className="input" />
          <input name="end" type="time" defaultValue="17:00" required className="input" />
          <input name="position" placeholder="Position" className="input" />
          <select name="locationId" className="input">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn sm:col-span-7 sm:justify-self-start">Add as draft</button>
        </ActionForm>
      )}
    </div>
  );
}

import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { addDays, formatDay, formatMinutes, formatTime, localDate, mondayOf } from '@/lib/time';
import type { Location, Member } from '@/lib/types';
import { addPunch, approveWeek, voidPunch } from '../workforce-actions';

interface Card {
  user: { id: string; email: string | null; displayName: string | null };
  shifts: { date: string; start: string; end: string | null; workedMinutes: number; breakMinutes: number; issues: string[]; punchIds: string[]; locationId: string }[];
  days: { date: string; workedMinutes: number; scheduledMinutes: number | null }[];
  weeks: { weekStart: string; workedMinutes: number; overtimeMinutes: number; approval: { approvedAt: string; outdated: boolean } | null }[];
  issues: { date: string; issue: string }[];
  totalMinutes: number;
}

export default async function TimecardsPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ week?: string }> }) {
  const { tenantId } = await params;
  const { week } = await searchParams;
  const locations = await api<Location[]>('/locations', { tenantId });
  const tz = locations[0]?.timezone ?? 'UTC';
  const monday = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : localDate(new Date(), tz));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const [{ people }, members] = await Promise.all([
    api<{ people: Card[] }>(`/timeclock/timecards?from=${monday}&to=${days[6]}`, { tenantId }),
    api<Member[]>('/members', { tenantId }),
  ]);
  const timezones = Object.fromEntries(locations.map((l) => [l.id, l.timezone]));
  const name = (u: Card['user']) => u.displayName ?? u.email ?? 'Unknown';

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Timecards</h1>
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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2">Person</th>
              {days.map((d) => (
                <th key={d} className="pb-2 text-right">
                  {formatDay(d).split(',')[0]}
                </th>
              ))}
              <th className="pb-2 text-right">Total</th>
              <th className="pb-2 text-right">Approval</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const wk = p.weeks.find((w) => w.weekStart === monday);
              return (
                <tr key={p.user.id} className="border-t border-stone-100 align-top">
                  <td className="py-2">
                    <span className="font-medium">{name(p.user)}</span>
                    {p.issues.map((i) => (
                      <span key={`${i.date}${i.issue}`} className="block text-xs text-red-700">
                        {formatDay(i.date)}: {i.issue}
                      </span>
                    ))}
                  </td>
                  {days.map((d) => {
                    const day = p.days.find((x) => x.date === d);
                    return (
                      <td key={d} className="text-right tabular-nums">
                        {day ? formatMinutes(day.workedMinutes) : '—'}
                        {day?.scheduledMinutes != null && <span className="block text-xs text-stone-400">of {formatMinutes(day.scheduledMinutes)}</span>}
                      </td>
                    );
                  })}
                  <td className="text-right font-medium tabular-nums">
                    {formatMinutes(wk?.workedMinutes ?? 0)}
                    {wk?.overtimeMinutes ? <span className="block text-xs text-amber-700">{formatMinutes(wk.overtimeMinutes)} overtime</span> : null}
                  </td>
                  <td className="text-right">
                    {wk?.approval && !wk.approval.outdated ? (
                      <span className="text-xs text-teal-700">Approved</span>
                    ) : (
                      <ActionForm action={approveWeek.bind(null, tenantId, p.user.id, monday)}>
                        {wk?.approval?.outdated && <span className="block text-xs text-amber-700">Changed since approval</span>}
                        <button className="btn-secondary px-2 py-1 text-xs">Approve</button>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              );
            })}
            {people.length === 0 && (
              <tr>
                <td colSpan={10} className="py-4 text-stone-500">
                  No time recorded this week.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {people.some((p) => p.shifts.length) && (
        <section className="space-y-2">
          <h2 className="font-medium">Shifts</h2>
          <ul className="card divide-y divide-stone-100 text-sm">
            {people.flatMap((p) =>
              p.shifts.map((s) => (
                <li key={s.punchIds.join()} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{name(p.user)}</span> · {formatDay(s.date)} · {formatTime(s.start, timezones[s.locationId] ?? tz)}–
                    {s.end ? formatTime(s.end, timezones[s.locationId] ?? tz) : '…'} · {formatMinutes(s.workedMinutes)}
                    {s.breakMinutes ? ` (${formatMinutes(s.breakMinutes)} break)` : ''}
                  </span>
                  <ActionForm action={voidPunch.bind(null, tenantId, s.punchIds[s.punchIds.length - 1]!)} className="flex items-center gap-2">
                    <input name="reason" placeholder="Why remove the last punch?" required className="input w-56 py-1 text-xs" />
                    <button className="text-xs text-red-700 hover:underline">Remove last punch</button>
                  </ActionForm>
                </li>
              )),
            )}
          </ul>
        </section>
      )}

      <ActionForm action={addPunch.bind(null, tenantId, timezones)} className="card grid gap-2 sm:grid-cols-6">
        <h2 className="font-medium sm:col-span-6">Add a missed punch</h2>
        <select name="userId" className="input sm:col-span-2">
          {members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.displayName ?? m.user.email}
            </option>
          ))}
        </select>
        <select name="kind" className="input">
          <option value="in">Clock in</option>
          <option value="out">Clock out</option>
          <option value="break_start">Break start</option>
          <option value="break_end">Break end</option>
        </select>
        <input name="at" type="datetime-local" required className="input sm:col-span-2" />
        <select name="locationId" className="input">
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input name="reason" placeholder="Reason (required)" required className="input sm:col-span-5" />
        <button className="btn">Add</button>
        <p className="text-xs text-stone-500 sm:col-span-6">Times are the store’s local time. You can’t change your own hours; another manager or the owner must.</p>
      </ActionForm>
    </div>
  );
}

import { randomUUID } from 'node:crypto';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDay, formatMinutes, formatTime, localDate } from '@/lib/time';
import type { Location } from '@/lib/types';
import { clockPunch } from '../workforce-actions';

interface Me {
  state: 'off' | 'working' | 'on_break';
  allowed: ('in' | 'out' | 'break_start' | 'break_end')[];
  currentShift: { start: string; workedMinutes: number; breakMinutes: number } | null;
  punches: { id: string; kind: string; occurredAt: string; locationId: string }[];
}

const LABEL = { in: 'Clock in', out: 'Clock out', break_start: 'Start break', break_end: 'End break' } as const;
const PAST = { in: 'Clocked in', out: 'Clocked out', break_start: 'Break started', break_end: 'Break ended' } as Record<string, string>;
const STATE = { off: 'You’re clocked out', working: 'You’re on the clock', on_break: 'You’re on a break' };

export default async function ClockPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [me, locations] = await Promise.all([api<Me>('/timeclock/me', { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const lastLocation = me.punches[0]?.locationId ?? locations[0]?.id;
  const where = new Map(locations.map((l) => [l.id, l]));
  // Times show in the store's own time zone, not the server's.
  const tz = (locationId?: string) => (locationId && where.get(locationId)?.timezone) || 'UTC';

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold">Clock in / out</h1>
      <section className="card space-y-4">
        <div>
          <p className="text-xl font-semibold">{STATE[me.state]}</p>
          {me.currentShift && (
            <p className="text-sm text-stone-600">
              Since {formatTime(me.currentShift.start, tz(lastLocation))} ·{' '}
              {formatMinutes(me.currentShift.workedMinutes)} worked{me.currentShift.breakMinutes ? ` · ${formatMinutes(me.currentShift.breakMinutes)} break` : ''}
            </p>
          )}
        </div>
        {me.allowed.map((kind) => (
          // A fresh id per render: a double tap records one punch.
          <ActionForm key={kind} action={clockPunch.bind(null, tenantId, kind, randomUUID())} className="space-y-2">
            {kind === 'in' && (
              <select name="locationId" defaultValue={lastLocation} className="input">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            {kind !== 'in' && <input type="hidden" name="locationId" value={lastLocation} />}
            <button className={`${kind === 'in' || kind === 'break_end' ? 'btn' : 'btn-secondary'} w-full py-3 text-base`}>{LABEL[kind]}</button>
          </ActionForm>
        ))}
      </section>
      {me.punches.length > 0 && (
        <section>
          <h2 className="font-medium">Recent</h2>
          <ul className="card mt-2 divide-y divide-stone-100 text-sm">
            {me.punches.map((p) => (
              <li key={p.id} className="flex justify-between py-2">
                <span>{PAST[p.kind]}</span>
                <span className="text-stone-500">
                  {formatDay(localDate(new Date(p.occurredAt), tz(p.locationId)))} {formatTime(p.occurredAt, tz(p.locationId))} · {where.get(p.locationId)?.name}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

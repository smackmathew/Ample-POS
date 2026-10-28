// Turns raw punches into shifts and weekly totals. Pure: no database access.

export type PunchKind = 'in' | 'out' | 'break_start' | 'break_end';

export interface Punch {
  id: string;
  kind: PunchKind;
  occurredAt: Date;
  locationId: string;
}

export interface WorkedShift {
  locationId: string;
  start: Date;
  /** Null while still clocked in (or if the clock-out is missing). */
  end: Date | null;
  breakMinutes: number;
  workedMinutes: number;
  /** Plain-language problems a manager should look at. */
  issues: string[];
  punchIds: string[];
}

export type ClockState = 'off' | 'working' | 'on_break';

const minutes = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

/** A shift still open after this long is treated as a forgotten clock-out. */
const MAX_OPEN_SHIFT_MS = 16 * 3600_000;

/**
 * Pairs punches into shifts. Work in progress is counted up to `now`; a
 * shift left open for more than 16 hours is flagged instead of counted.
 */
export function buildShifts(punches: Punch[], now = new Date()): WorkedShift[] {
  const sorted = [...punches].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const shifts: WorkedShift[] = [];
  let current: (WorkedShift & { breakStart: Date | null }) | null = null;

  const close = (end: Date | null, issue?: string) => {
    if (!current) return;
    if (current.breakStart) {
      if (end) current.breakMinutes += minutes(current.breakStart, end);
      current.issues.push('Break was never ended');
    }
    if (issue) current.issues.push(issue);
    current.end = end;
    const until = end ?? (now.getTime() - current.start.getTime() <= MAX_OPEN_SHIFT_MS ? now : null);
    current.workedMinutes = until ? Math.max(0, minutes(current.start, until) - current.breakMinutes) : 0;
    const { breakStart: _b, ...shift } = current;
    shifts.push(shift);
    current = null;
  };

  for (const p of sorted) {
    switch (p.kind) {
      case 'in':
        if (current) close(null, 'No clock-out before the next clock-in');
        current = { locationId: p.locationId, start: p.occurredAt, end: null, breakMinutes: 0, workedMinutes: 0, issues: [], punchIds: [p.id], breakStart: null };
        break;
      case 'break_start':
        if (!current) break;
        current.punchIds.push(p.id);
        if (current.breakStart) current.issues.push('Break started twice');
        else current.breakStart = p.occurredAt;
        break;
      case 'break_end':
        if (!current) break;
        current.punchIds.push(p.id);
        if (!current.breakStart) current.issues.push('Break ended without starting');
        else {
          current.breakMinutes += minutes(current.breakStart, p.occurredAt);
          current.breakStart = null;
        }
        break;
      case 'out':
        if (!current) {
          shifts.push({ locationId: p.locationId, start: p.occurredAt, end: p.occurredAt, breakMinutes: 0, workedMinutes: 0, issues: ['Clock-out without a clock-in'], punchIds: [p.id] });
          break;
        }
        current.punchIds.push(p.id);
        close(p.occurredAt);
        break;
    }
  }
  if (current) {
    const open = current as WorkedShift & { breakStart: Date | null };
    const stale = now.getTime() - open.start.getTime() > MAX_OPEN_SHIFT_MS;
    close(null, stale ? 'Still clocked in after 16 hours — clock-out probably missed' : undefined);
  }
  return shifts;
}

/** Where someone is right now, from their latest valid punch. */
export function clockState(punches: Punch[]): ClockState {
  const last = [...punches].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (!last || last.kind === 'out') return 'off';
  if (last.kind === 'break_start') return 'on_break';
  return 'working';
}

/** The punch kinds allowed next, so the clock can't record nonsense. */
export function allowedNext(state: ClockState): PunchKind[] {
  return { off: ['in'], working: ['break_start', 'out'], on_break: ['break_end', 'out'] }[state] as PunchKind[];
}

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Monday of the week containing a YYYY-MM-DD date. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export const OVERTIME_WEEKLY_MINUTES = 40 * 60;

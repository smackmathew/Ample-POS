/** 510 → "8h 30m". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the week containing a YYYY-MM-DD date. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

/**
 * The instant at which a wall-clock time ("2026-03-02T09:00") happens in a
 * time zone, e.g. 09:00 in Chicago. Handles daylight saving by checking the
 * zone's offset at the resulting instant.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const asUtc = Date.parse(`${local.length === 16 ? `${local}:00` : local}Z`);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant;
  };
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess);
  return new Date(guess);
}

export function formatTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Date and time of an instant in a time zone, e.g. "Mar 2, 2026, 9:05 AM". */
export function formatDateTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}

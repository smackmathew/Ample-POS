import { describe, expect, it } from 'vitest';
import { allowedNext, buildShifts, clockState, localDate, weekStart, type Punch } from './timecards';

const at = (iso: string) => new Date(iso);
let n = 0;
const punch = (kind: Punch['kind'], iso: string): Punch => ({ id: `p${n++}`, kind, occurredAt: at(iso), locationId: 'L' });

describe('buildShifts', () => {
  it('subtracts breaks from worked time', () => {
    const [shift] = buildShifts([
      punch('in', '2026-03-02T09:00:00Z'),
      punch('break_start', '2026-03-02T12:00:00Z'),
      punch('break_end', '2026-03-02T12:30:00Z'),
      punch('out', '2026-03-02T17:15:00Z'),
    ]);
    expect(shift).toMatchObject({ breakMinutes: 30, workedMinutes: 465, issues: [] });
  });

  it('flags a missing clock-out and counts nothing for it', () => {
    const shifts = buildShifts([punch('in', '2026-03-02T09:00:00Z'), punch('in', '2026-03-03T09:00:00Z'), punch('out', '2026-03-03T17:00:00Z')], at('2026-03-04T00:00:00Z'));
    expect(shifts.map((s) => [s.workedMinutes, s.issues])).toEqual([
      [0, ['No clock-out before the next clock-in']],
      [480, []],
    ]);
  });

  it('counts a shift in progress up to now, but not one left open for days', () => {
    const now = at('2026-03-02T11:00:00Z');
    expect(buildShifts([punch('in', '2026-03-02T09:00:00Z')], now)[0]).toMatchObject({ end: null, workedMinutes: 120, issues: [] });
    const stale = buildShifts([punch('in', '2026-02-27T09:00:00Z')], now)[0]!;
    expect(stale.workedMinutes).toBe(0);
    expect(stale.issues[0]).toMatch(/probably missed/);
  });

  it('closes a break left open at clock-out and flags it', () => {
    const [shift] = buildShifts([punch('in', '2026-03-02T09:00:00Z'), punch('break_start', '2026-03-02T12:00:00Z'), punch('out', '2026-03-02T13:00:00Z')]);
    expect(shift).toMatchObject({ breakMinutes: 60, workedMinutes: 180, issues: ['Break was never ended'] });
  });

  it('orders punches by time regardless of input order', () => {
    const [shift] = buildShifts([punch('out', '2026-03-02T17:00:00Z'), punch('in', '2026-03-02T09:00:00Z')]);
    expect(shift!.workedMinutes).toBe(480);
  });
});

describe('clock state', () => {
  it('only allows sensible next punches', () => {
    expect(clockState([])).toBe('off');
    expect(clockState([punch('in', '2026-03-02T09:00:00Z')])).toBe('working');
    expect(clockState([punch('in', '2026-03-02T09:00:00Z'), punch('break_start', '2026-03-02T10:00:00Z')])).toBe('on_break');
    expect(allowedNext('off')).toEqual(['in']);
    expect(allowedNext('on_break')).toEqual(['break_end', 'out']);
  });
});

describe('dates', () => {
  it('uses the location’s calendar day and Monday weeks', () => {
    // 03:30 UTC on Tuesday is still Monday evening in Chicago.
    expect(localDate(at('2026-03-03T03:30:00Z'), 'America/Chicago')).toBe('2026-03-02');
    expect(weekStart('2026-03-08')).toBe('2026-03-02'); // Sunday → previous Monday
    expect(weekStart('2026-03-02')).toBe('2026-03-02');
  });
});

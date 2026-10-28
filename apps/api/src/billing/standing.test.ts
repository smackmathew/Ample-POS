import { describe, expect, it } from 'vitest';
import { standing } from './standing';

const now = new Date('2026-06-15T12:00:00Z');
const base = { trialEndsAt: new Date('2026-06-20T00:00:00Z'), status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };

describe('billing standing', () => {
  it('is on trial until the trial ends, then lapses', () => {
    expect(standing(base, now)).toBe('trial');
    expect(standing({ ...base, trialEndsAt: new Date('2026-06-15T11:59:59Z') }, now)).toBe('lapsed');
  });

  it('follows a live subscription regardless of the trial', () => {
    const past = new Date('2026-01-01T00:00:00Z');
    expect(standing({ ...base, trialEndsAt: past, status: 'active' }, now)).toBe('active');
    expect(standing({ ...base, trialEndsAt: past, status: 'trialing' }, now)).toBe('active');
    expect(standing({ ...base, trialEndsAt: past, status: 'past_due' }, now)).toBe('past_due');
  });

  it('lapses when the subscription is canceled or unpaid after the trial', () => {
    const past = new Date('2026-01-01T00:00:00Z');
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'paused']) {
      expect(standing({ ...base, trialEndsAt: past, status }, now)).toBe('lapsed');
    }
    // An incomplete first payment during the trial does not cut the trial short.
    expect(standing({ ...base, status: 'incomplete' }, now)).toBe('trial');
  });

  it('ends a canceling subscription at the end of its period', () => {
    const past = new Date('2026-01-01T00:00:00Z');
    const canceling = { ...base, trialEndsAt: past, status: 'active', cancelAtPeriodEnd: true };
    expect(standing({ ...canceling, currentPeriodEnd: new Date('2026-07-01T00:00:00Z') }, now)).toBe('active');
    expect(standing({ ...canceling, currentPeriodEnd: new Date('2026-06-01T00:00:00Z') }, now)).toBe('lapsed');
  });
});

import { LIVE_STATUSES } from './provider';

export type Standing = 'trial' | 'active' | 'past_due' | 'lapsed';

export interface BillingSnapshot {
  trialEndsAt: Date;
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Whether the business may keep changing data in its paid tools.
 * - trial: no subscription yet and the free trial is running
 * - active: subscribed (including a trial carried into the subscription)
 * - past_due: a payment failed and the provider is retrying; still allowed
 * - lapsed: trial over with no working subscription; paid tools become read-only
 */
export function standing(b: BillingSnapshot, now = new Date()): Standing {
  const ended = b.cancelAtPeriodEnd && b.currentPeriodEnd !== null && b.currentPeriodEnd <= now;
  if (b.status && LIVE_STATUSES.has(b.status) && !ended) return b.status === 'past_due' ? 'past_due' : 'active';
  return b.trialEndsAt > now ? 'trial' : 'lapsed';
}

/** Read-only requests stay available when lapsed, so nobody loses sight of their data. */
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

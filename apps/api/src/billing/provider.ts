import type { BilledItem } from '@pos/db';

export interface ProviderSubscription {
  id: string;
  /** The provider's status: trialing, active, past_due, canceled, unpaid, incomplete, ... */
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Paid tools on the subscription; the provider keeps any base plan item to itself. */
  items: BilledItem[];
}

export interface CheckoutInput {
  tenantId: string;
  customerId: string;
  items: BilledItem[];
  /** Keep the free trial running inside the subscription until this time. */
  trialEnd: Date | null;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Where subscriptions live. The subscription is billed per active location for
 * each paid tool; our tenant_billing row is a copy refreshed after every change.
 */
export interface BillingProvider {
  readonly name: 'simulated' | 'stripe';
  createCustomer(input: { tenantId: string; name: string; email: string | null }): Promise<string>;
  /** Stripe sends the customer to hosted checkout; the simulated provider subscribes at once. */
  startCheckout(input: CheckoutInput): Promise<{ url: string } | { subscription: ProviderSubscription }>;
  /** Replaces the billed items (with proration) and returns the updated subscription. */
  updateItems(subscription: ProviderSubscription, items: BilledItem[], idempotencyKey: string): Promise<ProviderSubscription>;
  setCancelAtPeriodEnd(subscription: ProviderSubscription, cancel: boolean): Promise<ProviderSubscription>;
  /** The customer's current subscription as the provider sees it. Absent when our copy is the only record. */
  currentSubscription?(customerId: string): Promise<ProviderSubscription | null>;
  /** A self-service page for invoices and payment methods, when the provider has one. */
  portalUrl?(customerId: string, returnUrl: string): Promise<string>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** Subscription statuses under which the business keeps full use of its paid tools. */
export const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Statuses where a subscription still exists and a new checkout would double-bill. */
export const OPEN_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

/** Same items regardless of order. */
export function sameItems(a: readonly BilledItem[], b: readonly BilledItem[]): boolean {
  const key = (items: readonly BilledItem[]) =>
    items
      .map((i) => `${i.moduleId}:${i.quantity}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

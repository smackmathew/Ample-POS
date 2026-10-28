import type { BilledItem } from '@pos/db';
import { BILLING_CURRENCY, getModule, isModuleId } from '@pos/modules';
import { stripeRequest } from '../payments/stripe.provider';
import type { BillingProvider, CheckoutInput, ProviderSubscription } from './provider';
import { OPEN_STATUSES } from './provider';

interface StripePrice {
  id: string;
  lookup_key: string | null;
  metadata: Record<string, string>;
}

interface StripeSubscriptionItem {
  id: string;
  quantity?: number;
  current_period_end?: number;
  price: StripePrice;
}

interface StripeSubscription {
  id: string;
  status: string;
  created: number;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  items: { data: StripeSubscriptionItem[] };
}

/** Every subscription carries this $0 item, so it stays valid while no paid tool is on. */
const BASE = 'base';

/** Prices are found by lookup key; a new amount gets a new key, so price changes never edit a live price. */
export function lookupKey(moduleId: string, amountMinor: number): string {
  return `ample_${moduleId}_${amountMinor}_${BILLING_CURRENCY}_monthly`;
}

function planFor(moduleId: string): { name: string; amountMinor: number } {
  if (moduleId === BASE) return { name: 'Ample POS', amountMinor: 0 };
  if (!isModuleId(moduleId)) throw new Error(`Unknown module: ${moduleId}`);
  const mod = getModule(moduleId);
  return { name: `Ample POS – ${mod.name}`, amountMinor: mod.monthlyPriceMinor };
}

/**
 * Subscriptions on Ample POS's own Stripe account (not the merchants' payment
 * accounts): Checkout to subscribe, the customer portal for invoices and
 * cards, and subscription updates when tools or locations change. Products and
 * prices are created on first use, so a fresh Stripe account needs no setup.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly prices = new Map<string, string>();

  constructor(
    private readonly secretKey: string,
    private readonly options: { fetch?: typeof fetch } = {},
  ) {}

  async createCustomer(input: { tenantId: string; name: string; email: string | null }): Promise<string> {
    const customer = await this.call<{ id: string }>('POST', '/customers', `customer-${input.tenantId}`, {
      name: input.name,
      email: input.email ?? undefined,
      metadata: { tenant_id: input.tenantId },
    });
    return customer.id;
  }

  async startCheckout(input: CheckoutInput) {
    const lines = await this.lines(input.items);
    const session = await this.call<{ url: string }>('POST', '/checkout/sessions', undefined, {
      mode: 'subscription',
      customer: input.customerId,
      client_reference_id: input.tenantId,
      line_items: Object.fromEntries(lines.map((l, i) => [i, l])),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      subscription_data: {
        metadata: { tenant_id: input.tenantId },
        trial_end: input.trialEnd ? Math.floor(input.trialEnd.getTime() / 1000) : undefined,
      },
    });
    return { url: session.url };
  }

  async updateItems(subscription: ProviderSubscription, items: BilledItem[], idempotencyKey: string) {
    // Work from Stripe's current items rather than our copy, which may be stale.
    const current = await this.call<StripeSubscription>('GET', `/subscriptions/${encodeURIComponent(subscription.id)}`);
    const byModule = new Map(current.items.data.map((i) => [this.moduleOf(i.price), i]));
    const wanted = new Map([[BASE, 1], ...items.map((i) => [i.moduleId, i.quantity] as const)]);

    const changes: Record<string, unknown>[] = [];
    for (const [moduleId, item] of byModule) {
      // Leave alone anything added outside Ample POS (e.g. in the Stripe dashboard).
      if (moduleId === 'unknown') continue;
      if (!wanted.has(moduleId)) changes.push({ id: item.id, deleted: true });
      else if ((item.quantity ?? 1) !== wanted.get(moduleId)) changes.push({ id: item.id, quantity: wanted.get(moduleId) });
    }
    const added = [...wanted].filter(([moduleId]) => !byModule.has(moduleId)).map(([moduleId, quantity]) => ({ moduleId, quantity }));
    for (const line of await this.lines(added, false)) changes.push(line);
    if (!changes.length) return this.toSubscription(current);

    const updated = await this.call<StripeSubscription>('POST', `/subscriptions/${encodeURIComponent(subscription.id)}`, idempotencyKey, {
      items: Object.fromEntries(changes.map((c, i) => [i, c])),
      proration_behavior: 'create_prorations',
    });
    return this.toSubscription(updated);
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscription, cancel: boolean) {
    const updated = await this.call<StripeSubscription>('POST', `/subscriptions/${encodeURIComponent(subscription.id)}`, undefined, {
      cancel_at_period_end: cancel,
    });
    return this.toSubscription(updated);
  }

  async currentSubscription(customerId: string): Promise<ProviderSubscription | null> {
    const list = await this.call<{ data: StripeSubscription[] }>(
      'GET',
      `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=20`,
    );
    // Prefer one that is still open; otherwise the latest, so a cancellation is seen.
    const newest = [...list.data].sort((a, b) => b.created - a.created);
    const pick = newest.find((s) => OPEN_STATUSES.has(s.status)) ?? newest[0];
    return pick ? this.toSubscription(pick) : null;
  }

  async portalUrl(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.call<{ url: string }>('POST', '/billing_portal/sessions', undefined, { customer: customerId, return_url: returnUrl });
    return session.url;
  }

  private toSubscription(s: StripeSubscription): ProviderSubscription {
    // Newer API versions keep the billing period on each item instead of the subscription.
    const periodEnd = s.current_period_end ?? Math.max(0, ...s.items.data.map((i) => i.current_period_end ?? 0));
    return {
      id: s.id,
      status: s.status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      items: s.items.data
        .map((i) => ({ moduleId: this.moduleOf(i.price), quantity: i.quantity ?? 1 }))
        .filter((i) => i.moduleId !== BASE && i.moduleId !== 'unknown'),
    };
  }

  private moduleOf(price: StripePrice): string {
    return price.metadata?.module_id ?? 'unknown';
  }

  /** Price and quantity for each item, plus the base item unless told otherwise. */
  private async lines(items: BilledItem[], withBase = true): Promise<{ price: string; quantity: number }[]> {
    const all = withBase ? [{ moduleId: BASE, quantity: 1 }, ...items] : items;
    const keys = all.map((i) => {
      const plan = planFor(i.moduleId);
      return { ...i, ...plan, key: lookupKey(i.moduleId, plan.amountMinor) };
    });
    const missing = keys.filter((k) => !this.prices.has(k.key));
    if (missing.length) {
      const query = missing.map((k) => `lookup_keys[]=${encodeURIComponent(k.key)}`).join('&');
      const found = await this.call<{ data: StripePrice[] }>('GET', `/prices?active=true&limit=100&${query}`);
      for (const p of found.data) if (p.lookup_key) this.prices.set(p.lookup_key, p.id);
      for (const k of missing.filter((m) => !this.prices.has(m.key))) this.prices.set(k.key, await this.createPrice(k));
    }
    return keys.map((k) => ({ price: this.prices.get(k.key)!, quantity: k.quantity }));
  }

  private async createPrice(plan: { moduleId: string; name: string; amountMinor: number; key: string }): Promise<string> {
    const product = await this.call<{ id: string }>('POST', '/products', `product-${plan.key}`, {
      name: plan.name,
      metadata: { module_id: plan.moduleId },
    });
    const price = await this.call<{ id: string }>('POST', '/prices', `price-${plan.key}`, {
      product: product.id,
      currency: BILLING_CURRENCY,
      unit_amount: plan.amountMinor,
      recurring: { interval: 'month' },
      lookup_key: plan.key,
      metadata: { module_id: plan.moduleId },
    });
    return price.id;
  }

  private call<T>(method: 'GET' | 'POST', path: string, idempotencyKey?: string, params?: Record<string, unknown>): Promise<T> {
    return stripeRequest<T>(this.secretKey, method, path, { idempotencyKey, params, fetch: this.options.fetch });
  }
}

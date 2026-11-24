import { stripeRequest } from './stripe.provider';

/** What Stripe says about a merchant account. */
export interface MerchantStatus {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Information Stripe still needs, e.g. "individual.verification.document". */
  requirementsDue: string[];
  disabledReason: string | null;
  businessName: string | null;
  livemode: boolean;
}

/** Express accounts under the platform (Stripe Connect), and checking a business's own Stripe key. */
export interface MerchantConnect {
  readonly name: string;
  createExpressAccount(input: { tenantId: string; email: string | null; businessName: string; idempotencyKey: string }): Promise<string>;
  /** Stripe's hosted onboarding (or update) page for the account. */
  onboardingLink(accountId: string, urls: { returnUrl: string; refreshUrl: string }): Promise<string>;
  /** A one-time sign-in to the account's Express dashboard (payouts, balances). */
  dashboardLink(accountId: string): Promise<string>;
  account(accountId: string): Promise<MerchantStatus>;
  /** Checks a business's own secret key and reads its account. */
  ownAccount(secretKey: string): Promise<MerchantStatus>;
}

interface StripeAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { currently_due?: string[]; past_due?: string[]; disabled_reason?: string | null } | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
  email?: string | null;
}

function toStatus(a: StripeAccount, livemode: boolean): MerchantStatus {
  const due = [...new Set([...(a.requirements?.past_due ?? []), ...(a.requirements?.currently_due ?? [])])];
  return {
    id: a.id,
    chargesEnabled: a.charges_enabled,
    payoutsEnabled: a.payouts_enabled,
    detailsSubmitted: a.details_submitted,
    requirementsDue: due,
    disabledReason: a.requirements?.disabled_reason ?? null,
    businessName: a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? a.email ?? null,
    livemode,
  };
}

const isLive = (key: string) => /^(sk|rk)_live_/.test(key);

export class StripeConnect implements MerchantConnect {
  readonly name = 'stripe';

  constructor(
    private readonly platformKey: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async createExpressAccount(input: { tenantId: string; email: string | null; businessName: string; idempotencyKey: string }): Promise<string> {
    const account = await stripeRequest<{ id: string }>(this.platformKey, 'POST', '/accounts', {
      idempotencyKey: input.idempotencyKey,
      fetch: this.fetchImpl,
      params: {
        type: 'express',
        email: input.email ?? undefined,
        business_profile: { name: input.businessName },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { tenant_id: input.tenantId },
      },
    });
    return account.id;
  }

  async onboardingLink(accountId: string, urls: { returnUrl: string; refreshUrl: string }): Promise<string> {
    const link = await stripeRequest<{ url: string }>(this.platformKey, 'POST', '/account_links', {
      fetch: this.fetchImpl,
      params: { account: accountId, type: 'account_onboarding', return_url: urls.returnUrl, refresh_url: urls.refreshUrl },
    });
    return link.url;
  }

  async dashboardLink(accountId: string): Promise<string> {
    return (await stripeRequest<{ url: string }>(this.platformKey, 'POST', `/accounts/${encodeURIComponent(accountId)}/login_links`, { fetch: this.fetchImpl })).url;
  }

  async account(accountId: string): Promise<MerchantStatus> {
    return toStatus(await stripeRequest<StripeAccount>(this.platformKey, 'GET', `/accounts/${encodeURIComponent(accountId)}`, { fetch: this.fetchImpl }), isLive(this.platformKey));
  }

  async ownAccount(secretKey: string): Promise<MerchantStatus> {
    return toStatus(await stripeRequest<StripeAccount>(secretKey, 'GET', '/account', { fetch: this.fetchImpl }), isLive(secretKey));
  }
}

/**
 * Stands in for Stripe Connect in development and tests: onboarding "completes"
 * as soon as its link has been handed out. A business's own key still has to
 * look like a Stripe key and is checked against Stripe when one is reachable.
 */
export class SimulatedConnect implements MerchantConnect {
  readonly name = 'simulated';
  private readonly onboarded = new Set<string>();

  constructor(private readonly real: MerchantConnect | null = null) {}

  async createExpressAccount(input: { tenantId: string }): Promise<string> {
    return `acct_sim_${input.tenantId.replace(/-/g, '').slice(0, 16)}`;
  }

  async onboardingLink(accountId: string, urls: { returnUrl: string }): Promise<string> {
    this.onboarded.add(accountId);
    return `${urls.returnUrl}${urls.returnUrl.includes('?') ? '&' : '?'}simulated=1`;
  }

  async dashboardLink(accountId: string): Promise<string> {
    return `https://dashboard.stripe.com/test/connect/accounts/${accountId}`;
  }

  async account(accountId: string): Promise<MerchantStatus> {
    const done = this.onboarded.has(accountId);
    return {
      id: accountId,
      chargesEnabled: done,
      payoutsEnabled: done,
      detailsSubmitted: done,
      requirementsDue: done ? [] : ['business_profile.url', 'external_account'],
      disabledReason: done ? null : 'requirements.past_due',
      businessName: null,
      livemode: false,
    };
  }

  async ownAccount(secretKey: string): Promise<MerchantStatus> {
    if (this.real) return this.real.ownAccount(secretKey);
    return { id: `acct_own_${secretKey.slice(-8)}`, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [], disabledReason: null, businessName: null, livemode: isLive(secretKey) };
  }
}

export const MERCHANT_CONNECT = Symbol('MERCHANT_CONNECT');
export const STRIPE_FETCH = Symbol('STRIPE_FETCH');

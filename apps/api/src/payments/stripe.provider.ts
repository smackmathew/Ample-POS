import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ProviderUnavailableError,
  type CardPaymentProvider,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderRefund,
} from './provider';

interface StripePaymentIntent {
  id: string;
  status: string;
  client_secret: string | null;
  last_payment_error?: { message?: string } | null;
}

interface StripeRefund {
  id: string;
  status: string;
  failure_reason?: string | null;
}

const API = 'https://api.stripe.com/v1';

/** Flattens nested params into Stripe's form encoding: metadata[key]=value, list[]=a. */
export function formEncode(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item) => parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === 'object') parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

function mapStatus(status: string): ProviderPaymentStatus {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'canceled';
  // requires_payment_method (including after a decline), requires_confirmation, processing, ...
  return 'pending';
}

/**
 * Card-present payments through Stripe Terminal: the server creates the
 * PaymentIntent, the reader SDK on the register collects and confirms it.
 * Uses the REST API directly; `account` targets a Connect account.
 */
export class StripeCardProvider implements CardPaymentProvider {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    private readonly options: { account?: string; fetch?: typeof fetch } = {},
  ) {}

  async createCardPayment(input: { amountMinor: number; currency: string; idempotencyKey: string; metadata: Record<string, string> }): Promise<ProviderPayment> {
    const pi = await this.call<StripePaymentIntent>('POST', '/payment_intents', input.idempotencyKey, {
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: input.metadata,
    });
    return this.toPayment(pi);
  }

  async retrieve(ref: string): Promise<ProviderPayment> {
    return this.toPayment(await this.call<StripePaymentIntent>('GET', `/payment_intents/${encodeURIComponent(ref)}`));
  }

  async cancel(ref: string): Promise<ProviderPayment> {
    try {
      return this.toPayment(await this.call<StripePaymentIntent>('POST', `/payment_intents/${encodeURIComponent(ref)}/cancel`, `cancel-${ref}`));
    } catch (err) {
      // Already succeeded or canceled: report the real state instead of failing.
      if (err instanceof StripeApiError && err.status === 400) return this.retrieve(ref);
      throw err;
    }
  }

  async refund(input: { ref: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund> {
    const r = await this.call<StripeRefund>('POST', '/refunds', input.idempotencyKey, { payment_intent: input.ref, amount: input.amountMinor });
    const status = r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
    return { ref: r.id, status, error: r.failure_reason ?? null };
  }

  private toPayment(pi: StripePaymentIntent): ProviderPayment {
    return { ref: pi.id, status: mapStatus(pi.status), clientSecret: pi.client_secret, error: pi.last_payment_error?.message ?? null };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, idempotencyKey?: string, params?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (this.options.account) headers['Stripe-Account'] = this.options.account;
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(`${API}${path}`, { method, headers, body: params ? formEncode(params) : undefined });
    } catch (err) {
      throw new ProviderUnavailableError(`Could not reach Stripe: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429) throw new ProviderUnavailableError(body.error?.message ?? `Stripe returned ${res.status}`);
      throw new StripeApiError(res.status, body.error?.message ?? `Stripe returned ${res.status}`);
    }
    return body;
  }
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Verifies a Stripe-Signature header (t=timestamp,v1=hmac) over the raw body.
 * Returns the parsed event or null if the signature is missing, wrong or stale.
 */
export function verifyStripeWebhook(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): { type: string; data: { object: { id: string; object: string } } } | null {
  if (!header) return null;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const signatures = header
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .map((kv) => kv.slice(3));
  if (!Number.isFinite(t) || !signatures.length || Math.abs(nowSeconds - t) > toleranceSeconds) return null;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const ok = signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

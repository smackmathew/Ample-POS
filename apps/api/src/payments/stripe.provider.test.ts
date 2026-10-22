import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from './provider';
import { formEncode, StripeCardProvider, verifyStripeWebhook } from './stripe.provider';

function fakeStripe(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('StripeCardProvider', () => {
  it('creates a card-present PaymentIntent with an idempotency key', async () => {
    const stripe = fakeStripe([{ status: 200, body: { id: 'pi_1', status: 'requires_payment_method', client_secret: 'pi_1_secret' } }]);
    const provider = new StripeCardProvider('sk_test_x', { fetch: stripe.impl, account: 'acct_123' });
    const payment = await provider.createCardPayment({ amountMinor: 1299, currency: 'USD', idempotencyKey: 'pay-1', metadata: { saleId: 's1' } });

    expect(payment).toEqual({ ref: 'pi_1', status: 'pending', clientSecret: 'pi_1_secret', error: null });
    const { url, init } = stripe.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk_test_x', 'Idempotency-Key': 'pay-1', 'Stripe-Account': 'acct_123' });
    expect(decodeURIComponent(String(init.body))).toBe(
      'amount=1299&currency=usd&payment_method_types[]=card_present&capture_method=automatic&metadata[saleId]=s1',
    );
  });

  it('maps statuses and surfaces decline messages', async () => {
    const stripe = fakeStripe([
      { status: 200, body: { id: 'pi_1', status: 'requires_payment_method', client_secret: 's', last_payment_error: { message: 'Your card was declined.' } } },
      { status: 200, body: { id: 'pi_1', status: 'succeeded', client_secret: 's' } },
    ]);
    const provider = new StripeCardProvider('sk', { fetch: stripe.impl });
    expect(await provider.retrieve('pi_1')).toMatchObject({ status: 'pending', error: 'Your card was declined.' });
    expect(await provider.retrieve('pi_1')).toMatchObject({ status: 'succeeded', error: null });
  });

  it('reports the real state when canceling a payment that already succeeded', async () => {
    const stripe = fakeStripe([
      { status: 400, body: { error: { message: 'You cannot cancel this PaymentIntent because it has a status of succeeded.' } } },
      { status: 200, body: { id: 'pi_1', status: 'succeeded', client_secret: 's' } },
    ]);
    const provider = new StripeCardProvider('sk', { fetch: stripe.impl });
    expect((await provider.cancel('pi_1')).status).toBe('succeeded');
  });

  it('treats outages as retryable', async () => {
    const provider = new StripeCardProvider('sk', { fetch: fakeStripe([{ status: 503, body: {} }]).impl });
    await expect(provider.retrieve('pi_1')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('refunds against the PaymentIntent', async () => {
    const stripe = fakeStripe([{ status: 200, body: { id: 're_1', status: 'succeeded' } }]);
    const provider = new StripeCardProvider('sk', { fetch: stripe.impl });
    expect(await provider.refund({ ref: 'pi_1', amountMinor: 500, idempotencyKey: 'r1:p1' })).toEqual({ ref: 're_1', status: 'succeeded', error: null });
    expect(String(stripe.calls[0]!.init.body)).toBe('payment_intent=pi_1&amount=500');
  });
});

describe('verifyStripeWebhook', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', object: 'payment_intent' } } });
  const sign = (t: number, payload = body) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

  it('accepts a valid signature and rejects tampering, staleness and wrong secrets', () => {
    const now = 1_800_000_000;
    expect(verifyStripeWebhook(body, sign(now), secret, now)?.data.object.id).toBe('pi_1');
    expect(verifyStripeWebhook(body.replace('pi_1', 'pi_2'), sign(now), secret, now)).toBeNull();
    expect(verifyStripeWebhook(body, sign(now - 301), secret, now)).toBeNull();
    expect(verifyStripeWebhook(body, sign(now), 'whsec_other', now)).toBeNull();
    expect(verifyStripeWebhook(body, undefined, secret, now)).toBeNull();
  });
});

describe('formEncode', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ a: 1, m: { k: 'v w' }, l: ['x', 'y'], skip: undefined }))).toBe('a=1&m[k]=v w&l[]=x&l[]=y');
  });
});

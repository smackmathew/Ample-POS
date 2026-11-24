import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STRIPE_FETCH } from '../src/payments/connect';
import { CARD_PROVIDER } from '../src/payments/provider';
import { StripeCardProvider } from '../src/payments/stripe.provider';
import { Client, createTestApp, unique } from './helpers';

/** A fake Stripe API: accounts (Connect and own), account links, payment intents and refunds. Records every call. */
function fakeStripe() {
  const calls: { method: string; path: string; key: string; account: string | null; body: string }[] = [];
  const accounts = new Map<string, { charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; due: string[] }>();
  const ownKeys = new Map([['sk_test_ownkey1234567890', 'acct_own_1']]);
  const intents = new Map<string, { status: string; amount: number }>();
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const impl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1', '');
    const headers = init.headers as Record<string, string>;
    const key = (headers.Authorization ?? '').replace('Bearer ', '');
    const account = headers['Stripe-Account'] ?? null;
    const body = decodeURIComponent(String(init.body ?? ''));
    calls.push({ method: String(init.method), path, key, account, body });
    const acct = (id: string) => {
      const a = accounts.get(id)!;
      return { id, charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, details_submitted: a.details_submitted, requirements: { currently_due: a.due, disabled_reason: a.due.length ? 'requirements.past_due' : null }, business_profile: { name: 'Corner Cafe' } };
    };
    if (path === '/accounts' && init.method === 'POST') {
      const id = `acct_express_${++n}`;
      accounts.set(id, { charges_enabled: false, payouts_enabled: false, details_submitted: false, due: ['external_account'] });
      return json({ id });
    }
    if (path === '/account_links') return json({ url: `https://connect.stripe.test/setup/${/account=([^&]+)/.exec(body)![1]}` });
    const login = /^\/accounts\/([^/]+)\/login_links$/.exec(path);
    if (login) return json({ url: `https://connect.stripe.test/express/${login[1]}` });
    const one = /^\/accounts\/([^/]+)$/.exec(path);
    if (one) return json(acct(one[1]!));
    if (path === '/account') {
      const id = ownKeys.get(key);
      return id ? json({ id, charges_enabled: true, payouts_enabled: true, details_submitted: true, settings: { dashboard: { display_name: 'Own Cafe LLC' } } }) : json({ error: { message: 'Invalid API Key provided' } }, 401);
    }
    if (path === '/payment_intents') {
      const id = `pi_${++n}`;
      intents.set(id, { status: 'requires_payment_method', amount: Number(/amount=(\d+)/.exec(body)![1]) });
      return json({ id, status: 'requires_payment_method', client_secret: `${id}_secret` });
    }
    const pi = /^\/payment_intents\/([^/]+)$/.exec(path);
    if (pi) return json({ id: pi[1], status: intents.get(pi[1]!)!.status, client_secret: `${pi[1]}_secret` });
    if (path === '/refunds') return json({ id: `re_${++n}`, status: 'succeeded' });
    return json({ error: { message: `unhandled ${path}` } }, 404);
  }) as unknown as typeof fetch;
  return { calls, accounts, intents, impl };
}

const secretsKey = randomBytes(32).toString('base64');

async function shop(app: INestApplication) {
  const owner = await Client.signIn(app);
  await owner.createBusiness('Corner Cafe');
  for (const m of ['catalog', 'pos']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago' }).expect(201)).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const sale = async () => (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 1 }] }).expect(201)).body;
  return { owner, register, sale };
}

describe('merchant setup (built-in, on Stripe)', () => {
  const stripe = fakeStripe();
  const hookSecret = 'whsec_connect_test';
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp({
      env: { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_platform', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_CONNECT_WEBHOOK_SECRET: hookSecret, SECRETS_KEY: secretsKey, WEB_URL: 'https://hub.example' },
      providers: [
        [STRIPE_FETCH, stripe.impl],
        [CARD_PROVIDER, new StripeCardProvider('sk_test_platform', { fetch: stripe.impl })],
      ],
    });
  });
  afterAll(() => app.close());

  it('takes no cards until set up, so money never lands in the platform account', async () => {
    const { owner, sale } = await shop(app);
    const s = await sale();
    const refused = await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'card' }).expect(409);
    expect(refused.body.code).toBe('card_payments_not_set_up');
    expect((await owner.get('/payments/merchant').expect(200)).body).toMatchObject({ mode: 'off', ready: false, simulated: false });
    expect((await owner.get('/registers/sessions/current').expect(200)).body.paymentsProvider).toBe('none');
    // Cash still works.
    await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 500 }).expect(201);
  });

  it('onboards an Express account, then charges cards on it', async () => {
    const { owner, sale } = await shop(app);
    const start = (await owner.post('/payments/merchant/platform').expect(200)).body;
    const accountId = /setup\/(.+)$/.exec(start.url)![1]!;
    expect(stripe.calls.find((c) => c.path === '/accounts' && c.method === 'POST')!.body).toContain('type=express');
    expect(stripe.calls.find((c) => c.path === '/account_links')!.body).toContain(`return_url=https://hub.example/b/${owner.tenantId}/payments?onboarding=done`);
    let view = (await owner.get('/payments/merchant').expect(200)).body;
    expect(view).toMatchObject({ mode: 'platform', ready: false, platform: { accountId, chargesEnabled: false, requirementsDue: ['external_account'] } });
    const s = await sale();
    expect((await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'card' }).expect(409)).body.message).toContain('Finish setting up');

    // Starting again reuses the same account.
    await owner.post('/payments/merchant/platform').expect(200);
    expect(stripe.calls.filter((c) => c.path === '/accounts' && c.method === 'POST')).toHaveLength(1);

    // The owner finishes Stripe's form; Stripe tells us through the Connect webhook.
    Object.assign(stripe.accounts.get(accountId)!, { charges_enabled: true, payouts_enabled: true, details_submitted: true, due: [] });
    const event = JSON.stringify({ type: 'account.updated', account: accountId, data: { object: { id: accountId, object: 'account' } } });
    const t = Math.floor(Date.now() / 1000);
    await request(app.getHttpServer()).post('/webhooks/stripe-connect').set('Content-Type', 'application/json').set('Stripe-Signature', 'nope').send(event).expect(400);
    await request(app.getHttpServer())
      .post('/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${t},v1=${createHmac('sha256', hookSecret).update(`${t}.${event}`).digest('hex')}`)
      .send(event)
      .expect(200);
    view = (await owner.get('/payments/merchant').expect(200)).body;
    expect(view).toMatchObject({ mode: 'platform', ready: true, platform: { chargesEnabled: true, payoutsEnabled: true, requirementsDue: [] } });

    const card = (await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    expect(card.payment).toMatchObject({ provider: 'stripe', providerAccount: accountId });
    const created = stripe.calls.findLast((c) => c.path === '/payment_intents')!;
    expect(created).toMatchObject({ key: 'sk_test_platform', account: accountId });
    expect(created.body).not.toContain('application_fee'); // no platform fee

    expect((await owner.post('/payments/merchant/dashboard').expect(200)).body.url).toBe(`https://connect.stripe.test/express/${accountId}`);
    expect((await owner.get('/registers/sessions/current').expect(200)).body.paymentsProvider).toBe('stripe');
  });

  it('connects a business’s own Stripe account and refunds through it even after switching', async () => {
    const { owner, sale } = await shop(app);
    await owner.put('/payments/merchant/own', { secretKey: 'not-a-key' }).expect(400);
    expect((await owner.put('/payments/merchant/own', { secretKey: 'sk_test_wrongkey12345678' }).expect(409)).body.message).toContain('Invalid API Key');
    const view = (await owner.put('/payments/merchant/own', { secretKey: 'sk_test_ownkey1234567890', webhookSecret: 'whsec_ownhook12345' }).expect(200)).body;
    expect(view).toMatchObject({ mode: 'own', ready: true, own: { accountId: 'acct_own_1', businessName: 'Own Cafe LLC', livemode: false, webhookConfigured: true } });
    expect(view.ownWebhookUrl).toMatch(new RegExp(`/webhooks/stripe/merchant/${owner.tenantId}$`));
    expect(JSON.stringify(view)).not.toContain('sk_test_ownkey');

    const s = await sale();
    const card = (await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    expect(card.payment.providerAccount).toBe('acct_own_1');
    expect(stripe.calls.findLast((c) => c.path === '/payment_intents')).toMatchObject({ key: 'sk_test_ownkey1234567890', account: null });

    // Their own webhook completes the sale.
    stripe.intents.get(card.payment.providerRef)!.status = 'succeeded';
    const event = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: card.payment.providerRef, object: 'payment_intent' } } });
    const t = Math.floor(Date.now() / 1000);
    await request(app.getHttpServer())
      .post(`/webhooks/stripe/merchant/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', `t=${t},v1=${createHmac('sha256', 'whsec_ownhook12345').update(`${t}.${event}`).digest('hex')}`)
      .send(event)
      .expect(200);
    const paid = (await owner.get(`/sales/${s.id}`).expect(200)).body;
    expect(paid.status).toBe('completed');

    // Switched to built-in payments; the old sale still refunds through the business's own key.
    await owner.post('/payments/merchant/platform').expect(200);
    const register = (await owner.get('/registers/sessions/current').expect(200)).body.session;
    await owner.post(`/sales/${s.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: paid.lines[0].id, quantity: 1 }], restock: false, registerSessionId: register.id }).expect(201);
    expect(stripe.calls.findLast((c) => c.path === '/refunds')).toMatchObject({ key: 'sk_test_ownkey1234567890', account: null });

    await owner.post('/payments/merchant/off').expect(200);
    expect((await owner.get('/payments/merchant').expect(200)).body).toMatchObject({ mode: 'off', ready: false });
  });

  it('is for owners only', async () => {
    const { owner } = await shop(app);
    const manager = await owner.invite(await Client.signIn(app), 'manager');
    await manager.get('/payments/merchant').expect(403);
    await manager.post('/payments/merchant/platform').expect(403);
    await owner.post('/payments/merchant/platform').expect(200);
    const issues = (await owner.get('/payments/merchant').expect(200)).body;
    expect(issues.platform.chargesEnabled).toBe(false);
  });
});

describe('merchant setup (development, simulated)', () => {
  const stripe = fakeStripe();
  let app: INestApplication;
  const adminEmail = `${unique('staff')}@ample.example`;
  beforeAll(async () => {
    app = await createTestApp({ env: { SECRETS_KEY: secretsKey, PLATFORM_ADMIN_EMAILS: adminEmail }, providers: [[STRIPE_FETCH, stripe.impl]] });
  });
  afterAll(() => app.close());

  it('keeps the simulator for businesses that haven’t set up, and simulates onboarding', async () => {
    const { owner, sale } = await shop(app);
    expect((await owner.get('/payments/merchant').expect(200)).body).toMatchObject({ mode: 'off', ready: true, simulated: true });
    const s = await sale();
    await owner.post(`/sales/${s.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201);
    const start = (await owner.post('/payments/merchant/platform').expect(200)).body;
    expect(start.url).toMatch(/\/payments\?onboarding=done&simulated=1$/);
    expect((await owner.post('/payments/merchant/refresh').expect(200)).body).toMatchObject({ mode: 'platform', ready: true, platform: { chargesEnabled: true } });
  });

  it('shows the super admin each company’s setup and lets them switch card payments off', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner } = await shop(app);
    await owner.put('/payments/merchant/own', { secretKey: 'sk_test_ownkey1234567890' }).expect(200);
    const detail = (await admin.get(`/platform/companies/${owner.tenantId}`).expect(200)).body;
    expect(detail.merchant).toMatchObject({ mode: 'own', ownAccountId: 'acct_own_1', chargesEnabled: true });
    expect(JSON.stringify(detail)).not.toContain('ownkey');
    expect((await admin.get('/platform/companies').expect(200)).body.find((c: { id: string }) => c.id === owner.tenantId).merchant).toBe('own');

    await admin.post(`/platform/companies/${owner.tenantId}/card-payments/off`, { reason: 'Risk review' }).expect(200);
    expect((await owner.get('/payments/merchant').expect(200)).body.mode).toBe('off');
    const audit = (await owner.get('/audit').expect(200)).body.entries;
    expect(audit.find((e: { action: string }) => e.action === 'payments.merchant_off').data).toMatchObject({ reason: 'Risk review', by: 'Ample POS support' });
  });
});

import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_PROVIDER, type BillingProvider, type CheckoutInput, type ProviderSubscription } from '../src/billing/provider';
import { OutboxWorker } from '../src/worker/outbox.worker';
import { adminSql, Client, createTestApp, unique } from './helpers';

let app: INestApplication;
const db = adminSql();

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await db.end();
});

const DAY = 86_400_000;

async function business(a = app) {
  const owner = await Client.signIn(a);
  await owner.createBusiness();
  const store = (await owner.post('/locations', { name: 'Store', timezone: 'UTC' }).expect(201)).body;
  return { owner, store };
}

async function endTrial(tenantId: string) {
  await db`update tenant_billing set trial_ends_at = now() - interval '1 minute' where tenant_id = ${tenantId}`;
}

describe('billing (simulated)', () => {
  it('starts every business on a 14-day trial and prices the tools that are on, per location', async () => {
    const { owner } = await business();
    const tenant = (await owner.get('/tenant').expect(200)).body;
    expect(tenant.billing.standing).toBe('trial');
    const trialDays = (Date.parse(tenant.billing.trialEndsAt) - Date.parse(tenant.tenant.createdAt)) / DAY;
    expect(trialDays).toBeCloseTo(14, 5);

    // Every business starts on Starter: $39 a month for its first location.
    let summary = (await owner.get('/billing').expect(200)).body;
    expect(summary).toMatchObject({
      standing: 'trial',
      provider: 'simulated',
      subscription: null,
      plan: { id: 'starter', name: 'Starter', registersPerLocation: 1 },
      lines: [{ moduleId: 'plan:starter', name: 'Starter plan, first location', unitMinor: 3900, quantity: 1, totalMinor: 3900 }],
      monthlyTotalMinor: 3900,
      website: null,
    });
    expect(summary.plans.map((p: { id: string }) => p.id)).toEqual(['starter', 'growth', 'pro']);

    // Included tools cost nothing; paid add-ons are per location; extra locations are the plan's extra price.
    for (const m of ['catalog', 'pos', 'time-clock', 'reporting', 'customers', 'loyalty']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
    await owner.post('/locations', { name: 'Second', timezone: 'UTC' }).expect(201);
    summary = (await owner.get('/billing').expect(200)).body;
    expect(summary.lines).toEqual([
      { moduleId: 'plan:starter', name: 'Starter plan, first location', unitMinor: 3900, quantity: 1, totalMinor: 3900 },
      { moduleId: 'plan:starter:location', name: 'Extra locations (Starter)', unitMinor: 1900, quantity: 1, totalMinor: 1900 },
      { moduleId: 'time-clock', name: 'Time clock', unitMinor: 499, quantity: 2, totalMinor: 998 },
    ]);
    expect(summary.included).toEqual(['Product catalog', 'Point of sale', 'Reporting', 'Customers', 'Loyalty rewards']);
    expect(summary.monthlyTotalMinor).toBe(6798);

    // Growth: $59 + $29 per extra location.
    summary = (await owner.put('/billing/plan', { plan: 'growth' }).expect(200)).body;
    expect(summary.lines.slice(0, 2).map((l: { unitMinor: number }) => l.unitMinor)).toEqual([5900, 2900]);
    await owner.put('/billing/plan', { plan: 'gold' }).expect(400);

    // The trial cannot be extended by the application.
    await expect(db.begin(async (tx) => {
      await tx`set local role pos_app`;
      await tx`select set_config('app.tenant_id', ${owner.tenantId!}, true)`;
      await tx`update tenant_billing set trial_ends_at = now() + interval '1 year'`;
    })).rejects.toThrow(/permission denied/);
  });

  it('is managed by the owner only, but every member sees the standing', async () => {
    const { owner } = await business();
    const manager = await owner.invite(await Client.signIn(app), 'manager');
    await manager.get('/billing').expect(403);
    await manager.post('/billing/checkout').expect(403);
    expect((await manager.get('/tenant').expect(200)).body.billing.standing).toBe('trial');

    const nav = (await owner.get('/navigation').expect(200)).body.sections[0].items.map((i: { label: string }) => i.label);
    expect(nav).toContain('Billing');
  });

  it('makes paid tools read-only after the trial until the business subscribes', async () => {
    const { owner, store } = await business();
    for (const m of ['catalog', 'time-clock']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
    await endTrial(owner.tenantId!);
    expect((await owner.get('/tenant').expect(200)).body.billing.standing).toBe('lapsed');

    const blocked = await owner.post('/timeclock/punches', { id: randomUUID(), kind: 'in', locationId: store.id }).expect(402);
    expect(blocked.body).toMatchObject({ code: 'subscription_required' });
    expect(blocked.body.message).toContain('Time clock');
    // Reading stays available, as do included tools and the rest of the hub.
    await owner.get('/timeclock/me').expect(200);
    await owner.post('/catalog/products', { name: 'Mug', variants: [{ name: 'Default', sku: unique('MUG'), priceMinor: 1200 }] }).expect(201);
    await owner.put('/modules/tasks', { enabled: true }).expect(200);

    const res = await owner.post('/billing/checkout').expect(201);
    expect(res.body).toEqual({ subscribed: true });
    const summary = (await owner.get('/billing').expect(200)).body;
    expect(summary.standing).toBe('active');
    expect(summary.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
    await owner.post('/timeclock/punches', { id: randomUUID(), kind: 'in', locationId: store.id }).expect(201);

    await owner.post('/billing/checkout').expect(409);
  });

  it('keeps the subscription in step with tools and locations', async () => {
    const { owner } = await business();
    const worker = app.get(OutboxWorker);
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    await owner.put('/modules/pos', { enabled: true }).expect(200);
    await owner.post('/billing/checkout').expect(201);
    const items = async () => (await db`select items from tenant_billing where tenant_id = ${owner.tenantId!}`)[0]!.items;
    expect(await items()).toEqual([{ moduleId: 'plan:starter', quantity: 1, unitMinor: 3900 }]);

    await owner.put('/modules/scheduling', { enabled: true }).expect(200);
    const second = (await owner.post('/locations', { name: 'Second', timezone: 'UTC' }).expect(201)).body;
    await worker.runOnce();
    expect(await items()).toEqual([
      { moduleId: 'plan:starter', quantity: 1, unitMinor: 3900 },
      { moduleId: 'plan:starter:location', quantity: 1, unitMinor: 1900 },
      { moduleId: 'scheduling', quantity: 2, unitMinor: 499 },
    ]);

    // A plan change follows too.
    await owner.put('/billing/plan', { plan: 'pro' }).expect(200);
    await worker.runOnce();
    expect((await items()).slice(0, 2)).toEqual([
      { moduleId: 'plan:pro', quantity: 1, unitMinor: 7900 },
      { moduleId: 'plan:pro:location', quantity: 1, unitMinor: 3900 },
    ]);

    await owner.patch(`/locations/${second.id}`, { archived: true }).expect(200);
    await owner.put('/modules/scheduling', { enabled: false }).expect(200);
    await worker.runOnce();
    expect(await items()).toEqual([{ moduleId: 'plan:pro', quantity: 1, unitMinor: 7900 }]);
  });

  it('cancels at the end of the period and can be resumed', async () => {
    const { owner } = await business();
    await owner.post('/billing/checkout').expect(201);
    expect((await owner.post('/billing/cancel').expect(200)).body.subscription.cancelAtPeriodEnd).toBe(true);
    expect((await owner.get('/tenant').expect(200)).body.billing).toMatchObject({ standing: 'active', cancelAtPeriodEnd: true });
    expect((await owner.post('/billing/resume').expect(200)).body.subscription.cancelAtPeriodEnd).toBe(false);
    // The simulated provider has no portal.
    await owner.post('/billing/portal').expect(409);

    const fresh = await business();
    await fresh.owner.post('/billing/cancel').expect(409);
  });
});

/** Stands in for Stripe: hosted checkout, then the subscription appears and a webhook arrives. */
class FakeStripeBilling implements BillingProvider {
  readonly name = 'stripe';
  checkouts: CheckoutInput[] = [];
  subscriptions = new Map<string, ProviderSubscription>();
  updates: { id: string; items: ProviderSubscription['items'] }[] = [];

  async createCustomer() {
    return `cus_${randomUUID()}`;
  }
  async startCheckout(input: CheckoutInput) {
    this.checkouts.push(input);
    return { url: `https://checkout.stripe.test/${input.customerId}` };
  }
  async updateItems(sub: ProviderSubscription, items: ProviderSubscription['items']) {
    this.updates.push({ id: sub.id, items });
    const updated = { ...sub, items };
    for (const [customer, s] of this.subscriptions) if (s.id === sub.id) this.subscriptions.set(customer, updated);
    return updated;
  }
  async setCancelAtPeriodEnd(sub: ProviderSubscription, cancel: boolean) {
    return { ...sub, cancelAtPeriodEnd: cancel };
  }
  charges: { customerId: string; charge: { key: string; name: string; amountMinor: number } }[] = [];
  async chargeOnce(customerId: string, charge: { key: string; name: string; amountMinor: number }) {
    this.charges.push({ customerId, charge });
  }
  async currentSubscription(customerId: string) {
    return this.subscriptions.get(customerId) ?? null;
  }
  async portalUrl(customerId: string, returnUrl: string) {
    return `https://billing.stripe.test/${customerId}?return=${encodeURIComponent(returnUrl)}`;
  }
}

describe('billing (stripe)', () => {
  const secret = 'whsec_billing_test';
  const fake = new FakeStripeBilling();
  let stripeApp: INestApplication;

  beforeAll(async () => {
    stripeApp = await createTestApp({
      env: { BILLING_PROVIDER: 'stripe', BILLING_STRIPE_SECRET_KEY: 'sk_test_x', BILLING_STRIPE_WEBHOOK_SECRET: secret, WEB_URL: 'https://hub.example' },
      providers: [[BILLING_PROVIDER, fake]],
    });
  });

  afterAll(async () => {
    await stripeApp.close();
  });

  const signed = (event: object) => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    return { payload, header: `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}` };
  };
  const webhook = (event: object) => {
    const { payload, header } = signed(event);
    return request(stripeApp.getHttpServer()).post('/webhooks/stripe-billing').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
  };

  it('sends the owner to Checkout with the rest of the trial, then follows Stripe via webhooks', async () => {
    const { owner } = await business(stripeApp);
    await owner.put('/modules/time-clock', { enabled: true }).expect(200);
    const res = await owner.post('/billing/checkout').expect(201);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\/cus_/);
    const input = fake.checkouts.at(-1)!;
    expect(input).toMatchObject({
      tenantId: owner.tenantId,
      items: [
        { moduleId: 'plan:starter', quantity: 1, unitMinor: 3900 },
        { moduleId: 'time-clock', quantity: 1, unitMinor: 499 },
      ],
      successUrl: `https://hub.example/b/${owner.tenantId}/billing?checkout=success`,
    });
    const trialEndsAt = (await owner.get('/tenant').expect(200)).body.billing.trialEndsAt;
    expect(input.trialEnd?.toISOString()).toBe(trialEndsAt);

    // Abandoned checkout: still on trial, and a second attempt reuses the customer.
    await owner.post('/billing/checkout').expect(201);
    expect(fake.checkouts.at(-1)!.customerId).toBe(input.customerId);

    // Stripe creates the subscription and tells us; the body is not trusted, only the customer id.
    fake.subscriptions.set(input.customerId, { id: 'sub_1', status: 'trialing', currentPeriodEnd: new Date(trialEndsAt), cancelAtPeriodEnd: false, items: input.items });
    await webhook({ type: 'customer.subscription.created', data: { object: { id: 'sub_1', object: 'subscription', customer: input.customerId, status: 'active' } } }).expect(200);
    let summary = (await owner.get('/billing').expect(200)).body;
    expect(summary).toMatchObject({ standing: 'active', canManageOnline: true, subscription: { status: 'trialing' } });

    // A tool turned on after checkout is added to the subscription by the worker.
    await owner.put('/modules/tasks', { enabled: true }).expect(200);
    await stripeApp.get(OutboxWorker).runOnce();
    expect(fake.updates.at(-1)).toEqual({
      id: 'sub_1',
      items: [
        { moduleId: 'plan:starter', quantity: 1, unitMinor: 3900 },
        { moduleId: 'time-clock', quantity: 1, unitMinor: 499 },
        { moduleId: 'tasks', quantity: 1, unitMinor: 499 },
      ],
    });

    // Adding the online store while subscribed charges its setup on the next invoice, and adds the plan's sync fee.
    await owner.put('/billing/website', { addon: 'simple' }).expect(200);
    expect(fake.charges.at(-1)).toMatchObject({ customerId: input.customerId, charge: { key: 'website:setup:simple', amountMinor: 39900 } });
    await stripeApp.get(OutboxWorker).runOnce();
    expect(fake.updates.at(-1)!.items.at(-1)).toEqual({ moduleId: 'website:maintenance', quantity: 1, unitMinor: 999 });
    // Upgrading to the custom store charges the difference only.
    await owner.put('/billing/website', { addon: 'complex' }).expect(200);
    expect(fake.charges.at(-1)!.charge).toMatchObject({ key: 'website:setup:complex', amountMinor: 20000 });

    const portal = await owner.post('/billing/portal').expect(200);
    expect(portal.body.url).toBe(`https://billing.stripe.test/${input.customerId}?return=${encodeURIComponent(`https://hub.example/b/${owner.tenantId}/billing`)}`);

    // Payment fails, then the subscription is canceled for non-payment.
    fake.subscriptions.set(input.customerId, { ...fake.subscriptions.get(input.customerId)!, status: 'past_due' });
    await webhook({ type: 'invoice.payment_failed', data: { object: { id: 'in_1', object: 'invoice', customer: input.customerId } } }).expect(200);
    expect((await owner.get('/tenant').expect(200)).body.billing.standing).toBe('past_due');

    await endTrial(owner.tenantId!);
    fake.subscriptions.set(input.customerId, { ...fake.subscriptions.get(input.customerId)!, status: 'canceled' });
    await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', object: 'subscription', customer: input.customerId } } }).expect(200);
    summary = (await owner.get('/billing').expect(200)).body;
    expect(summary).toMatchObject({ standing: 'lapsed', subscription: null });

    // Subscribing again does not bring back the trial.
    await owner.post('/billing/checkout').expect(201);
    expect(fake.checkouts.at(-1)!.trialEnd).toBeNull();

    const audit = await db`select action, data from audit_log where tenant_id = ${owner.tenantId!} and action = 'billing.status_changed' order by id`;
    expect(audit.map((a) => a.data.to)).toEqual(['trialing', 'past_due', 'canceled']);
  });

  it('refreshes on return from Checkout without waiting for the webhook', async () => {
    const { owner } = await business(stripeApp);
    await owner.post('/billing/checkout').expect(201);
    const customer = fake.checkouts.at(-1)!.customerId;
    fake.subscriptions.set(customer, { id: 'sub_2', status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * DAY), cancelAtPeriodEnd: false, items: [] });
    expect((await owner.post('/billing/refresh').expect(200)).body).toMatchObject({ standing: 'active', subscription: { status: 'active' } });
  });

  it('rejects unsigned webhooks and ignores unknown customers', async () => {
    await request(stripeApp.getHttpServer()).post('/webhooks/stripe-billing').set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=00').send('{}').expect(400);
    await webhook({ type: 'customer.updated', data: { object: { id: 'cus_nobody', object: 'customer' } } }).expect(200);
    // Not offered when billing runs on the simulated provider.
    await request(app.getHttpServer()).post('/webhooks/stripe-billing').send('{}').expect(404);
  });
});

describe('plans', () => {
  it('limits open registers per location by plan', async () => {
    const { owner, store } = await business();
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    await owner.put('/modules/pos', { enabled: true }).expect(200);
    await owner.post('/registers/sessions', { locationId: store.id, openingFloatMinor: 0 }).expect(201);
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const refused = await staff.post('/registers/sessions', { locationId: store.id, openingFloatMinor: 0 }).expect(409);
    expect(refused.body).toMatchObject({ code: 'register_limit' });
    expect(refused.body.message).toContain('Starter plan allows 1 open register per location');
    // Another location has its own register.
    const second = (await owner.post('/locations', { name: 'Second', timezone: 'UTC' }).expect(201)).body;
    await staff.post('/registers/sessions', { locationId: second.id, openingFloatMinor: 0 }).expect(201);
    await owner.put('/billing/plan', { plan: 'growth' }).expect(200);
    const manager = await owner.invite(await Client.signIn(app), 'manager');
    await manager.post('/registers/sessions', { locationId: store.id, openingFloatMinor: 0 }).expect(201);
  });

  it('adds the online store: setup at checkout, the plan’s sync fee monthly, and website sync with it', async () => {
    const { owner } = await business();
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    expect((await owner.put('/modules/ecommerce-sync', { enabled: true }).expect(409)).body.code).toBe('website_addon_required');
    const summary = (await owner.put('/billing/website', { addon: 'complex' }).expect(200)).body;
    expect(summary.website).toEqual({ id: 'complex', name: 'Custom online store', setupMinor: 59900, setupCharged: false });
    expect(summary.lines.at(-1)).toEqual({ moduleId: 'website:maintenance', name: 'Online store sync', unitMinor: 999, quantity: 1, totalMinor: 999 });
    await owner.put('/modules/ecommerce-sync', { enabled: true }).expect(200);

    // Checkout charges the setup once (the simulated provider subscribes at once).
    await owner.post('/billing/checkout').expect(201);
    expect((await owner.get('/billing').expect(200)).body.website.setupCharged).toBe(true);

    // Removing the store turns website sync off and stops the monthly fee.
    const removed = (await owner.put('/billing/website', { addon: null }).expect(200)).body;
    expect(removed.website).toBeNull();
    expect(removed.lines.map((l: { moduleId: string }) => l.moduleId)).toEqual(['plan:starter']);
    expect((await owner.get('/modules').expect(200)).body.find((m: { id: string }) => m.id === 'ecommerce-sync').enabled).toBe(false);
  });
});

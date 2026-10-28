import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_PROVIDER } from '../src/payments/provider';
import { StripeCardProvider } from '../src/payments/stripe.provider';
import { Client, createTestApp } from './helpers';

/** Records Stripe Terminal calls and answers like Stripe would. */
function fakeStripe() {
  const calls: { method: string; path: string; body: string; key: string | null }[] = [];
  let n = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    calls.push({ method: String(init.method), path, body: decodeURIComponent(String(init.body ?? '')), key: headers['Idempotency-Key'] ?? null });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === '/v1/terminal/locations') return json({ id: `tml_${++n}` });
    if (path.startsWith('/v1/terminal/locations/')) return json({ id: path.split('/').pop() });
    if (path === '/v1/terminal/connection_tokens') return json({ secret: `pst_test_${++n}` });
    return new Response(JSON.stringify({ error: { message: `unhandled ${path}` } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const ADDRESS = { line1: '100 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'us' };

async function register(app: INestApplication) {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  await owner.put('/modules/catalog', { enabled: true }).expect(200);
  await owner.put('/modules/pos', { enabled: true }).expect(200);
  const store = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago' }).expect(201)).body;
  const cashier = await owner.invite(await Client.signIn(app), 'staff');
  const device = (await owner.post('/devices', { locationId: store.id, name: 'Front register', kind: 'register' }).expect(201)).body;
  cashier.deviceCredential = device.credential;
  return { owner, cashier, store };
}

describe('card readers with Stripe Terminal', () => {
  const stripe = fakeStripe();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      env: { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
      providers: [[CARD_PROVIDER, new StripeCardProvider('sk_test_fake', { fetch: stripe.impl })]],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('needs the store address, then registers the store with Stripe once and hands out connection tokens', async () => {
    const { owner, cashier, store } = await register(app);
    expect((await cashier.get('/terminal/config').expect(200)).body).toEqual({
      provider: 'stripe',
      readers: 'sdk',
      location: { ready: false, problem: 'Add Main St’s street address in Locations to connect card readers.' },
    });
    const missing = await cashier.post('/terminal/connection-token').expect(409);
    expect(missing.body.code).toBe('address_required');

    const updated = (await owner.patch(`/locations/${store.id}`, { address: { ...ADDRESS, line2: '' } }).expect(200)).body;
    expect(updated.address).toEqual({ line1: '100 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' });
    expect((await cashier.get('/terminal/config').expect(200)).body.location).toEqual({ ready: true, problem: null });

    const before = stripe.calls.length;
    const first = (await cashier.post('/terminal/connection-token').expect(200)).body;
    expect(first.secret).toMatch(/^pst_test_/);
    expect(first.locationRef).toMatch(/^tml_/);
    const created = stripe.calls.slice(before);
    expect(created.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/terminal/locations', 'POST /v1/terminal/connection_tokens']);
    expect(created[0]!.body).toBe(
      'display_name=Main St&address[line1]=100 Main St&address[city]=Chicago&address[state]=IL&address[postal_code]=60601&address[country]=US',
    );
    expect(created[0]!.key).toMatch(new RegExp(`^terminal-location-${store.id}-`));
    expect(created[1]!.body).toBe(`location=${first.locationRef}`);

    // The same store is not registered again.
    const second = (await cashier.post('/terminal/connection-token').expect(200)).body;
    expect(second.locationRef).toBe(first.locationRef);
    expect(stripe.calls.at(-2)!.path).toBe('/v1/terminal/connection_tokens');

    // A changed address updates Stripe's record in place.
    await owner.patch(`/locations/${store.id}`, { address: { ...ADDRESS, line1: '200 Main St' } }).expect(200);
    const third = (await cashier.post('/terminal/connection-token').expect(200)).body;
    expect(third.locationRef).toBe(first.locationRef);
    expect(stripe.calls.at(-2)).toMatchObject({ method: 'POST', path: `/v1/terminal/locations/${first.locationRef}` });
  });

  it('only serves paired devices of businesses using Point of sale', async () => {
    const { owner, cashier } = await register(app);
    await owner.post('/terminal/connection-token').expect(400);
    const handheldUser = await owner.invite(await Client.signIn(app), 'staff');
    await handheldUser.get('/terminal/config').expect(400);
    await owner.put('/modules/pos', { enabled: false }).expect(200);
    await cashier.get('/terminal/config').expect(403);
  });

  it('rejects bad addresses', async () => {
    const { owner, store } = await register(app);
    const res = await owner.patch(`/locations/${store.id}`, { address: { ...ADDRESS, country: 'USA' } }).expect(400);
    expect(JSON.stringify(res.body)).toContain('two-letter country code');
    await owner.patch(`/locations/${store.id}`, { address: null }).expect(200);
  });
});

describe('card readers with the simulated processor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('tells the register to show approve/decline buttons instead of an SDK reader', async () => {
    const { cashier } = await register(app);
    expect((await cashier.get('/terminal/config').expect(200)).body).toEqual({
      provider: 'simulated',
      readers: 'simulated',
      location: { ready: true, problem: null },
    });
    expect((await cashier.post('/terminal/connection-token').expect(409)).body.code).toBe('no_card_readers');
  });
});

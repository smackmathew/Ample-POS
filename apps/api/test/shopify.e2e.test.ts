import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/core/secrets';
import { SHOPIFY_FETCH } from '../src/integrations/shopify/client';
import { OutboxWorker } from '../src/worker/outbox.worker';
import { FakeShopify, type FakeVariant } from './fake-shopify';
import { adminSql, Client, createTestApp, unique } from './helpers';

let app: INestApplication;
let worker: OutboxWorker;
let shopify: FakeShopify;

beforeAll(async () => {
  app = await createTestApp({
    env: {
      SECRETS_KEY: randomBytes(32).toString('base64'),
      PUBLIC_API_URL: 'https://pos.example.com',
      WEB_URL: 'https://hub.example.com',
      SHOPIFY_CLIENT_ID: 'ample-client-id',
      SHOPIFY_CLIENT_SECRET: 'ample-client-secret',
    },
    // Each test gets a fresh fake store; requests always go to the current one.
    providers: [[SHOPIFY_FETCH, ((url, init) => shopify.fetch(url, init)) as typeof fetch]],
  });
  worker = app.get(OutboxWorker);
});

beforeEach(() => {
  shopify = new FakeShopify();
});

afterAll(async () => {
  await app.close();
});

/** A business with catalog, inventory and website sync on, one store location, and the fake Shopify connected. */
async function connected() {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  for (const m of ['catalog', 'inventory', 'ecommerce-sync']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const store = (await owner.post('/locations', { name: 'Store', timezone: 'UTC' }).expect(201)).body;
  await owner.post('/integrations/shopify/connect', { shopDomain: shopify.domain, accessToken: shopify.token, webhookSecret: shopify.webhookSecret }).expect(201);
  return { owner, store };
}

async function onHand(owner: Client, locationId: string, variantId: string): Promise<number> {
  const res = await owner.get(`/inventory/levels?locationId=${locationId}`).expect(200);
  return res.body.levels.find((l: { variantId: string }) => l.variantId === variantId)?.onHand ?? 0;
}

/** Imports the catalog and links Shopify's first location to the store; returns our variant id for a Shopify variant. */
async function linkedStore(owner: Client, storeId: string) {
  await owner.post('/integrations/shopify/import').expect(201);
  await owner.put(`/integrations/shopify/locations/${encodeURIComponent(shopify.locations[0]!.id)}`, { locationId: storeId }).expect(200);
  await owner.put('/integrations/shopify/settings', { onlineOrdersLocationId: storeId }).expect(200);
  const sql = adminSql();
  try {
    const rows = await sql`select external_id, internal_id from external_mappings where kind = 'variant'`;
    const map = new Map(rows.map((r) => [r.external_id as string, r.internal_id as string]));
    return (v: FakeVariant) => map.get(v.id)!;
  } finally {
    await sql.end();
  }
}

const sendWebhook = (connId: string, hook: { body: string; headers: Record<string, string> }) =>
  request(app.getHttpServer()).post(`/webhooks/shopify/${connId}`).set(hook.headers).send(hook.body);

describe('connecting a store', () => {
  it('verifies the token and currency, and never returns credentials', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    await owner.get('/integrations/shopify').expect(403); // module off
    for (const m of ['catalog', 'ecommerce-sync']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);

    const body = { shopDomain: shopify.domain, accessToken: shopify.token, webhookSecret: shopify.webhookSecret };
    await owner.post('/integrations/shopify/connect', { ...body, shopDomain: 'evil.example.com' }).expect(400);
    await owner.post('/integrations/shopify/connect', { ...body, accessToken: 'shpat_wrong_token' }).expect(400);
    shopify.currency = 'CAD';
    await owner.post('/integrations/shopify/connect', body).expect(400);
    shopify.currency = 'USD';

    const res = await owner.post('/integrations/shopify/connect', { ...body, shopDomain: `https://${shopify.domain}/admin` }).expect(201);
    expect(res.body).toMatchObject({ connected: true, shopDomain: shopify.domain, status: 'active' });
    expect(res.body.webhookUrl).toBe(`https://pos.example.com/webhooks/shopify/${res.body.id}`);
    expect(JSON.stringify(res.body)).not.toContain(shopify.token);
    await owner.post('/integrations/shopify/connect', body).expect(409);

    const sql = adminSql();
    try {
      const [row] = await sql`select credentials from integration_connections where id = ${res.body.id}`;
      expect(row!.credentials).not.toContain(shopify.token);
    } finally {
      await sql.end();
    }

    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get('/integrations/shopify').expect(403);
  });

  it('registers webhooks pointing at this server', async () => {
    const { owner } = await connected();
    const res = await owner.post('/integrations/shopify/webhooks').expect(201);
    expect(res.body.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(shopify.webhooks.map((w) => w.topic)).toEqual(['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'ORDERS_CREATE', 'ORDERS_CANCELLED', 'APP_UNINSTALLED']);
    expect(shopify.webhooks[0]!.uri).toMatch(/^https:\/\/pos\.example\.com\/webhooks\/shopify\/[0-9a-f-]+$/);
  });
});

describe('Connect with Shopify (OAuth)', () => {
  async function ownerWithSync() {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    for (const m of ['catalog', 'inventory', 'ecommerce-sync']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
    return owner;
  }

  /** What Shopify appends to the redirect after the merchant approves. */
  function callback(state: string, overrides: Record<string, string> = {}, secret = shopify.clientSecret) {
    const params: Record<string, string> = { code: 'approval-code-1', host: 'aG9zdA', shop: shopify.domain, state, timestamp: String(Math.floor(Date.now() / 1000)), ...overrides };
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    return { ...params, hmac: createHmac('sha256', secret).update(message).digest('hex') };
  }

  it('connects through Shopify’s approval page with an expiring token', async () => {
    const owner = await ownerWithSync();
    expect((await owner.get('/integrations/shopify').expect(200)).body).toEqual({ connected: false, oauthEnabled: true });
    const start = (await owner.post('/integrations/shopify/oauth/start', { shopDomain: shopify.domain }).expect(201)).body;
    const url = new URL(start.authorizeUrl);
    expect(url.host).toBe(shopify.domain);
    expect(url.searchParams.get('client_id')).toBe(shopify.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe('https://hub.example.com/shopify/callback');
    const state = url.searchParams.get('state')!;

    const done = (await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(201)).body;
    expect(done).toMatchObject({ connected: true, method: 'oauth', shopDomain: shopify.domain });
    expect(shopify.tokenRequests[0]).toMatchObject({ code: 'approval-code-1', expiring: '1' });
    expect(JSON.stringify(done)).not.toMatch(/shpua_|shprt_/);
  });

  it('rejects tampered, foreign or replayed callbacks', async () => {
    const owner = await ownerWithSync();
    const start = (await owner.post('/integrations/shopify/oauth/start', { shopDomain: shopify.domain }).expect(201)).body;
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;

    // Signed with the wrong secret, or altered after signing.
    await owner.post('/integrations/shopify/oauth/complete', { params: callback(state, {}, 'not-the-secret'), nonce: start.nonce }).expect(400);
    const altered = { ...callback(state), shop: 'other-store.myshopify.com' };
    await owner.post('/integrations/shopify/oauth/complete', { params: altered, nonce: start.nonce }).expect(400);
    // A different browser (no matching nonce) or a different person can't finish someone else's flow.
    await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: 'f'.repeat(32) }).expect(400);
    const colleague = await owner.invite(await Client.signIn(app), 'owner');
    await colleague.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(400);
    // A forged state is refused.
    await owner.post('/integrations/shopify/oauth/complete', { params: callback('forged-state'), nonce: start.nonce }).expect(400);

    await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(201);
    // Replaying the same approval doesn't create a second connection or reuse the code.
    await owner.delete('/integrations/shopify').expect(200);
    const replay = await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(400);
    expect(replay.body.message).toMatch(/not valid/);
  });

  it('refreshes the hourly token before it expires, and asks to reconnect when Shopify refuses', async () => {
    const owner = await ownerWithSync();
    shopify.accessTokenTtl = 60; // inside the refresh margin, so the next call refreshes
    const start = (await owner.post('/integrations/shopify/oauth/start', { shopDomain: shopify.domain }).expect(201)).body;
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(201);
    shopify.addProduct('Mug', [{ sku: unique('M'), price: '9.00' }]);

    shopify.expireAccessTokens();
    await owner.post('/integrations/shopify/import').expect(201);
    expect(shopify.tokenRequests.map((r) => r.grant_type ?? 'code')).toEqual(['code', 'refresh_token']);

    // Refresh token no longer accepted (e.g. app uninstalled): the store needs reconnecting.
    shopify.refreshTokens.clear();
    shopify.expireAccessTokens();
    await owner.post('/integrations/shopify/import').expect(400);
    expect((await owner.get('/integrations/shopify').expect(200)).body).toMatchObject({ status: 'error', statusMessage: expect.stringContaining('Reconnect') });
  });

  it('verifies webhooks for app connections with the app’s secret', async () => {
    const owner = await ownerWithSync();
    const start = (await owner.post('/integrations/shopify/oauth/start', { shopDomain: shopify.domain }).expect(201)).body;
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    const conn = (await owner.post('/integrations/shopify/oauth/complete', { params: callback(state), nonce: start.nonce }).expect(201)).body;
    await sendWebhook(conn.id, shopify.webhook('orders/create', 'gid://shopify/Order/1', 'w1', shopify.clientSecret)).expect(200);
    await sendWebhook(conn.id, shopify.webhook('orders/create', 'gid://shopify/Order/1', 'w2', shopify.webhookSecret)).expect(401);
  });
});

describe('catalog import (Shopify → Ample POS)', () => {
  it('creates products, matches existing items by SKU, and updates on re-import', async () => {
    const { owner } = await connected();
    const sku = unique('MUG');
    const existing = (await owner.post('/catalog/products', { name: 'Old mug name', variants: [{ sku, priceMinor: 900 }] }).expect(201)).body;

    const tee = shopify.addProduct('T-shirt', [
      { title: 'Small', sku: unique('TS-S'), price: '20.00', barcode: unique('111') },
      { title: 'Large', sku: unique('TS-L'), price: '22.5' },
    ]);
    shopify.addProduct('Mug', [{ sku: sku.toLowerCase(), price: '12.99' }]);
    shopify.addProduct('Gift card', [{ price: '25.00', tracked: false }]);

    const first = (await owner.post('/integrations/shopify/import').expect(201)).body;
    expect(first).toMatchObject({ products: 3, created: 3, matched: 1, updated: 0, skipped: 0 });

    const { products } = (await owner.get('/catalog/products?limit=50').expect(200)).body;
    expect(products.map((p: { name: string }) => p.name).sort()).toEqual(['Gift card', 'Mug', 'T-shirt']);
    const mug = products.find((p: { name: string }) => p.name === 'Mug');
    // The existing item was reused, not duplicated.
    expect(mug.id).toBe(existing.id);
    expect(mug.variants[0]).toMatchObject({ id: existing.variants[0].id, name: 'Default', priceMinor: 1299 });
    const teeLocal = products.find((p: { name: string }) => p.name === 'T-shirt');
    expect(teeLocal.variants.map((v: { name: string; priceMinor: number }) => [v.name, v.priceMinor])).toEqual([
      ['Small', 2000],
      ['Large', 2250],
    ]);
    expect(teeLocal.variants[0].barcodes).toEqual(tee.variants[0]!.barcodes);
    expect(products.find((p: { name: string }) => p.name === 'Gift card').variants[0].trackInventory).toBe(false);

    // Changes in Shopify flow through; nothing is duplicated.
    tee.variants[1]!.price = '24.00';
    tee.variants.shift();
    tee.title = 'Classic tee';
    const second = (await owner.post('/integrations/shopify/import').expect(201)).body;
    expect(second).toMatchObject({ created: 0, updated: 3 });
    const after = (await owner.get('/catalog/products?status=all&limit=50').expect(200)).body.products;
    expect(after).toHaveLength(3);
    const classic = after.find((p: { name: string }) => p.name === 'Classic tee');
    // Small was removed in Shopify (archived here, price untouched); Large's new price arrived.
    const byName = Object.fromEntries(classic.variants.map((v: { name: string; status: string; priceMinor: number }) => [v.name, [v.status, v.priceMinor]]));
    expect(byName).toEqual({ Small: ['archived', 2000], Large: ['active', 2400] });
  });

  it('reports SKU clashes instead of failing the import', async () => {
    const { owner } = await connected();
    const sku = unique('DUP');
    shopify.addProduct('A', [{ sku, price: '1.00' }]);
    shopify.addProduct('B', [{ sku, price: '2.00' }]);
    await owner.post('/integrations/shopify/import').expect(201);
    const issues = (await owner.get('/integrations/shopify/issues').expect(200)).body;
    expect(issues).toEqual([expect.objectContaining({ kind: 'duplicate_sku' })]);
    await owner.post(`/integrations/shopify/issues/${issues[0].id}/resolve`).expect(201);
    expect((await owner.get('/integrations/shopify/issues').expect(200)).body).toEqual([]);
  });

  it('applies product updates from webhooks', async () => {
    const { owner } = await connected();
    const mug = shopify.addProduct('Mug', [{ sku: unique('M'), price: '10.00' }]);
    await owner.post('/integrations/shopify/import').expect(201);
    const conn = (await owner.get('/integrations/shopify').expect(200)).body;

    mug.variants[0]!.price = '11.50';
    await sendWebhook(conn.id, shopify.webhook('products/update', mug.id)).expect(200);
    await worker.runOnce();
    const local = (await owner.get('/catalog/products?search=Mug').expect(200)).body.products[0];
    expect(local.variants[0].priceMinor).toBe(1150);
  });
});

describe('stock (Ample POS → Shopify)', () => {
  it('pushes on-hand quantities to linked locations with compare-and-swap and idempotency keys', async () => {
    const { owner, store } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    shopify.levels.set(`${tee.variants[0]!.inventoryItemId}|${shopify.locations[0]!.id}`, 3);
    const local = await linkedStore(owner, store.id);

    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId: local(tee.variants[0]!), quantity: 10 }] }).expect(201);
    await worker.runOnce();
    expect(shopify.level(tee.variants[0]!)).toBe(10);
    expect(shopify.setCalls).toHaveLength(1);
    expect(shopify.setCalls[0]).toMatchObject({ quantities: [{ quantity: 10, changeFromQuantity: 3 }] });
    expect(shopify.setCalls[0]!.key).toMatch(/^[0-9a-f]{32}$/);
    // The unlinked Shopify location is left alone.
    expect(shopify.level(tee.variants[0]!, shopify.locations[1]!.id)).toBeUndefined();

    // Nothing changed: nothing sent.
    expect((await owner.post('/integrations/shopify/push').expect(201)).body).toMatchObject({ pushed: 0, unchanged: 1 });
    expect(shopify.setCalls).toHaveLength(1);
  });

  it('adopts Shopify stock for items it has never counted instead of pushing zero', async () => {
    const { owner, store } = await connected();
    const counted = shopify.addProduct('Counted', [{ sku: unique('C'), price: '5.00' }]);
    const fresh = shopify.addProduct('Fresh', [{ sku: unique('F'), price: '5.00' }]);
    const notStocked = shopify.addProduct('Elsewhere', [{ sku: unique('E'), price: '5.00' }]);
    shopify.levels.set(`${counted.variants[0]!.inventoryItemId}|${shopify.locations[0]!.id}`, 4);
    shopify.levels.set(`${fresh.variants[0]!.inventoryItemId}|${shopify.locations[0]!.id}`, 7);
    const local = await linkedStore(owner, store.id);
    // We counted this one ourselves: 2 on hand. Ours wins.
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId: local(counted.variants[0]!), quantity: 2 }] }).expect(201);

    const res = (await owner.post('/integrations/shopify/push').expect(201)).body;
    expect(res).toMatchObject({ seeded: 1, pushed: 1 });
    expect(shopify.level(counted.variants[0]!)).toBe(2);
    expect(shopify.level(fresh.variants[0]!)).toBe(7);
    expect(await onHand(owner, store.id, local(fresh.variants[0]!))).toBe(7);
    // Not stocked at the Shopify location: left alone on both sides.
    expect(shopify.level(notStocked.variants[0]!)).toBeUndefined();
    expect(await onHand(owner, store.id, local(notStocked.variants[0]!))).toBe(0);
    const movements = (await owner.get(`/inventory/movements?variantId=${local(fresh.variants[0]!)}`).expect(200)).body.movements;
    expect(movements).toEqual([expect.objectContaining({ reason: 'adjustment', quantityDelta: 7, note: 'Starting stock from Shopify' })]);
  });

  it('never pushes while the Inventory tool is off', async () => {
    const { owner, store } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    shopify.levels.set(`${tee.variants[0]!.inventoryItemId}|${shopify.locations[0]!.id}`, 9);
    await linkedStore(owner, store.id);
    await owner.put('/modules/inventory', { enabled: false }).expect(200);
    expect((await owner.post('/integrations/shopify/push').expect(201)).body).toMatchObject({ seeded: 0, pushed: 0 });
    expect(shopify.level(tee.variants[0]!)).toBe(9);
  });
});

describe('online orders (Shopify → Ample POS)', () => {
  it('records an online order once, even when the webhook is delivered twice', async () => {
    const { owner, store } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    const local = await linkedStore(owner, store.id);
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId: local(tee.variants[0]!), quantity: 10 }] }).expect(201);
    await worker.runOnce();
    const conn = (await owner.get('/integrations/shopify').expect(200)).body;

    const order = shopify.placeOrder([{ variant: tee.variants[0]!, quantity: 2 }]);
    const hook = shopify.webhook('orders/create', order.id, 'wh-order-1');
    await sendWebhook(conn.id, hook).expect(200);
    const dup = await sendWebhook(conn.id, hook).expect(200);
    expect(dup.body.duplicate).toBe(true);
    await worker.runOnce();

    expect(await onHand(owner, store.id, local(tee.variants[0]!))).toBe(8);
    expect(shopify.level(tee.variants[0]!)).toBe(8);
    // Shopify already had 8, so no push (and no false conflict) was needed.
    expect(shopify.setCalls).toHaveLength(1);

    // Cancelling restocks both sides.
    shopify.cancelOrder(order);
    await sendWebhook(conn.id, shopify.webhook('orders/cancelled', order.id)).expect(200);
    await worker.runOnce();
    expect(await onHand(owner, store.id, local(tee.variants[0]!))).toBe(10);
    expect(shopify.level(tee.variants[0]!)).toBe(10);
  });

  it('rejects webhooks with a bad signature or unknown connection', async () => {
    const { owner } = await connected();
    const conn = (await owner.get('/integrations/shopify').expect(200)).body;
    await sendWebhook(conn.id, shopify.webhook('orders/create', 'gid://shopify/Order/1', 'x', 'wrong-secret')).expect(401);
    await sendWebhook(randomUUID(), shopify.webhook('orders/create', 'gid://shopify/Order/1')).expect(404);
  });

  it('converges when an online order and an in-store change race', async () => {
    const { owner, store } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    const local = await linkedStore(owner, store.id);
    const variantId = local(tee.variants[0]!);
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId, quantity: 10 }] }).expect(201);
    await worker.runOnce();
    const conn = (await owner.get('/integrations/shopify').expect(200)).body;

    // Online order lands in Shopify; its webhook is delayed. Meanwhile we receive 5 more in store.
    const order = shopify.placeOrder([{ variant: tee.variants[0]!, quantity: 2 }]);
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId, quantity: 5 }] }).expect(201);
    await worker.runOnce();
    // The push saw Shopify change underneath it and backed off instead of overwriting the sale.
    expect(shopify.level(tee.variants[0]!)).toBe(8);

    await sendWebhook(conn.id, shopify.webhook('orders/create', order.id)).expect(200);
    await worker.runOnce();
    await owner.post('/integrations/shopify/push').expect(201); // stands in for the scheduled retry
    await owner.post('/integrations/shopify/push').expect(201);

    expect(await onHand(owner, store.id, variantId)).toBe(13);
    expect(shopify.level(tee.variants[0]!)).toBe(13);
  });

  it('reconciliation picks up orders whose webhooks never arrived', async () => {
    const { owner, store } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    const local = await linkedStore(owner, store.id);
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId: local(tee.variants[0]!), quantity: 6 }] }).expect(201);
    await worker.runOnce();

    shopify.placeOrder([{ variant: tee.variants[0]!, quantity: 1 }]);
    const res = (await owner.post('/integrations/shopify/reconcile').expect(201)).body;
    expect(res.orders).toBe(1);
    expect(await onHand(owner, store.id, local(tee.variants[0]!))).toBe(5);
    expect(shopify.level(tee.variants[0]!)).toBe(5);
    // Running it again changes nothing.
    await owner.post('/integrations/shopify/reconcile').expect(201);
    expect(await onHand(owner, store.id, local(tee.variants[0]!))).toBe(5);
  });

  it('flags orders it cannot place when no online-orders location is chosen', async () => {
    const { owner } = await connected();
    const tee = shopify.addProduct('Tee', [{ sku: unique('T'), price: '20.00' }]);
    await owner.post('/integrations/shopify/import').expect(201);
    shopify.placeOrder([{ variant: tee.variants[0]!, quantity: 1 }]);
    await owner.post('/integrations/shopify/reconcile').expect(201);
    const issues = (await owner.get('/integrations/shopify/issues').expect(200)).body;
    expect(issues.map((i: { kind: string }) => i.kind)).toEqual(['orders_location_missing']);
  });
});

describe('SecretBox', () => {
  it('round-trips and detects tampering', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const sealed = box.seal({ token: 'abc' });
    expect(box.open(sealed)).toEqual({ token: 'abc' });
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox('short')).toThrow(/32 bytes/);
  });
});

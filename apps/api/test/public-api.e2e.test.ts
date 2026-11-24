import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { isPrivateAddress, safeWebhookFetch, WEBHOOK_FETCH, WebhookDispatcher, type WebhookFetch } from '../src/developer/webhook-dispatcher';
import { adminSql, Client, createTestApp } from './helpers';

let app: INestApplication;
const db = adminSql();
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
let answer = 200;
const fakeFetch: WebhookFetch = async (url, init) => {
  sent.push({ url, headers: init.headers, body: init.body });
  return { status: answer };
};

beforeAll(async () => {
  app = await createTestApp({ providers: [[WEBHOOK_FETCH, fakeFetch]] });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

/** Calls the API the way another app would: only the API key, no X-Tenant-Id. */
function withKey(key: string) {
  const server = app.getHttpServer();
  return {
    get: (path: string) => request(server).get(path).set('Authorization', `Bearer ${key}`),
    post: (path: string, body: object = {}) => request(server).post(path).set('Authorization', `Bearer ${key}`).send(body),
    patch: (path: string, body: object = {}) => request(server).patch(path).set('Authorization', `Bearer ${key}`).send(body),
  };
}

async function shop() {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  for (const m of ['catalog', 'inventory', 'pos', 'customers']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const store = (await owner.post('/locations', { name: 'Main', timezone: 'UTC' }).expect(201)).body;
  return { owner, store };
}

describe('API keys', () => {
  it('works for one business without X-Tenant-Id, and is shown only once', async () => {
    const { owner } = await shop();
    const created = (await owner.post('/api-keys', { name: 'Client hub', permissions: ['*'], readOnly: true }).expect(201)).body;
    expect(created.key).toMatch(/^ak_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    const listed = (await owner.get('/api-keys').expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'Client hub', readOnly: true, hint: created.hint });
    expect(JSON.stringify(listed)).not.toContain(created.key);

    const hub = withKey(created.key);
    await hub.get('/catalog/products').expect(200);
    // Read-only: no changes.
    expect((await hub.post('/catalog/products', { name: 'X', variants: [{ priceMinor: 100 }] }).expect(403)).body.message).toMatch(/read-only/);
    // The header may be sent, but must match.
    await request(app.getHttpServer()).get('/catalog/products').set('Authorization', `Bearer ${created.key}`).set('X-Tenant-Id', owner.tenantId!).expect(200);
    const other = await shop();
    await request(app.getHttpServer()).get('/catalog/products').set('Authorization', `Bearer ${created.key}`).set('X-Tenant-Id', other.owner.tenantId!).expect(403);
    // Keys can't manage keys, or reach routes outside the business.
    await hub.get('/api-keys').expect(403);
    await hub.get('/me').expect(403);
    await hub.get('/platform/companies').expect(403);

    await withKey(created.key.slice(0, -2) + 'xx').get('/catalog/products').expect(401);
    await owner.post(`/api-keys/${created.id}/revoke`).expect(200);
    await hub.get('/catalog/products').expect(401);
  });

  it('only allows the permissions chosen for the key, and never more than its creator has', async () => {
    const { owner } = await shop();
    const key = (await owner.post('/api-keys', { name: 'Catalog only', permissions: ['catalog.read'] }).expect(201)).body.key;
    const hub = withKey(key);
    await hub.get('/catalog/products').expect(200);
    await hub.get('/customers').expect(403);
    await owner.post('/api-keys', { name: 'Bad', permissions: ['catalog.read', 'made.up'] }).expect(400);

    // A manager can't make keys at all (api.manage is for owners by default).
    const manager = await owner.invite(await Client.signIn(app), 'manager');
    await manager.post('/api-keys', { name: 'Mine', permissions: ['*'] }).expect(403);

    // If the creator leaves the business, the key stops working.
    const coOwner = await owner.invite(await Client.signIn(app), 'owner');
    const theirs = (await coOwner.post('/api-keys', { name: 'Theirs', permissions: ['*'] }).expect(201)).body.key;
    await withKey(theirs).get('/catalog/products').expect(200);
    await db`update memberships set status = 'suspended' where tenant_id = ${owner.tenantId!} and user_id = (select id from users where email = ${coOwner.email})`;
    expect((await withKey(theirs).get('/catalog/products').expect(403)).body.message).toMatch(/no longer part/);
  });
});

describe('pushing data in', () => {
  it('upserts products by SKU and sets stock levels, row by row', async () => {
    const { owner, store } = await shop();
    const hub = withKey((await owner.post('/api-keys', { name: 'Hub', permissions: ['*'] }).expect(201)).body.key);

    const first = (
      await hub
        .post('/integrations/products/upsert', {
          products: [
            { sku: 'TEE-RED-M', name: 'Red tee', variantName: 'Medium', priceMinor: 2500, barcodes: ['0001'] },
            { sku: 'MUG-1', name: 'Mug', priceMinor: 1200 },
          ],
        })
        .expect(200)
    ).body;
    expect(first).toMatchObject({ created: 2, updated: 0, errors: 0 });

    const second = (
      await hub
        .post('/integrations/products/upsert', {
          products: [
            { sku: 'tee-red-m', name: 'Red tee', priceMinor: 2700 },
            { sku: 'CAP-1', name: 'Cap', priceMinor: 1500, barcodes: ['0001'] },
          ],
        })
        .expect(200)
    ).body;
    expect(second).toMatchObject({ created: 0, updated: 1, errors: 1 });
    expect(second.results[1]).toMatchObject({ sku: 'CAP-1', status: 'error', error: 'A barcode is already used by another product' });
    const tee = (await owner.get(`/catalog/lookup?code=TEE-RED-M`).expect(200)).body;
    expect(JSON.stringify(tee)).toContain('2700');

    const levels = (
      await hub
        .post('/integrations/inventory/levels', {
          locationId: store.id,
          levels: [
            { sku: 'TEE-RED-M', onHand: 12 },
            { sku: 'MUG-1', onHand: 0 },
            { sku: 'NOPE', onHand: 3 },
          ],
        })
        .expect(200)
    ).body;
    expect(levels).toMatchObject({ set: 1, unchanged: 1, errors: 1 });
    const again = (await hub.post('/integrations/inventory/levels', { locationId: store.id, levels: [{ sku: 'TEE-RED-M', onHand: 10 }] }).expect(200)).body;
    expect(again.results[0]).toMatchObject({ status: 'set', before: 12, after: 10 });
    const onHand = (await owner.get(`/inventory/levels?locationId=${store.id}`).expect(200)).body;
    expect(JSON.stringify(onHand)).toContain('"onHand":10');

    // The change feed has it all, in order, with what's on hand now.
    const feed = (await hub.get('/events?types=inventory.changed').expect(200)).body;
    expect(feed.events.map((e: { data: { lines: { onHand: number }[] } }) => e.data.lines[0]!.onHand)).toEqual([12, 10]);
    const rest = (await hub.get(`/events?after=${feed.events[0].id}&types=inventory.changed`).expect(200)).body;
    expect(rest.events).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
  });

  it('only shows a key the events it may read', async () => {
    const { owner } = await shop();
    await owner.post('/customers', { name: 'Ana' }).expect(201);
    await owner.post('/catalog/products', { name: 'Tea', variants: [{ priceMinor: 300 }] }).expect(201);
    const all = (await withKey((await owner.post('/api-keys', { name: 'All', permissions: ['*'] }).expect(201)).body.key).get('/events').expect(200)).body;
    expect(all.events.map((e: { type: string }) => e.type)).toEqual(['location.created', 'customer.created', 'product.created']);
    const catalogOnly = withKey((await owner.post('/api-keys', { name: 'Catalog', permissions: ['catalog.read'] }).expect(201)).body.key);
    expect((await catalogOnly.get('/events').expect(200)).body.events.map((e: { type: string }) => e.type)).toEqual(['location.created', 'product.created']);
    const types = (await catalogOnly.get('/events/types').expect(200)).body;
    expect(types.find((t: { type: string }) => t.type === 'customer.created').readable).toBe(false);
  });
});

describe('webhooks', () => {
  it('sends signed events to the URLs that asked for them, and retries failures', async () => {
    const { owner, store } = await shop();
    const hub = withKey((await owner.post('/api-keys', { name: 'Hub', permissions: ['*'] }).expect(201)).body.key);
    // The hub registers its own endpoint with its key.
    const endpoint = (await hub.post('/webhooks', { url: 'https://hub.example.com/ample', events: ['product.created', 'inventory.changed'] }).expect(201)).body;
    expect(endpoint.secret).toMatch(/^whsec_/);
    await hub.post('/webhooks', { url: 'http://10.0.0.5/hook', events: ['*'] }).expect(400);
    await hub.post('/webhooks', { url: 'https://hub.example.com/x', events: ['made.up'] }).expect(400);

    await hub.post('/integrations/products/upsert', { products: [{ sku: 'A-1', name: 'Apron', priceMinor: 900 }] }).expect(200);
    await hub.post('/integrations/inventory/levels', { locationId: store.id, levels: [{ sku: 'A-1', onHand: 4 }] }).expect(200);
    await owner.post('/customers', { name: 'Not subscribed' }).expect(201);

    const dispatcher = app.get(WebhookDispatcher);
    sent.length = 0;
    answer = 200;
    await dispatcher.deliverDue();
    const mine = sent.filter((s) => s.url === 'https://hub.example.com/ample');
    expect(mine.map((s) => s.headers['Ample-Event-Type'])).toEqual(['product.created', 'inventory.changed']);
    const [ts, v1] = mine[1]!.headers['Ample-Signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(createHmac('sha256', endpoint.secret).update(`${ts}.${mine[1]!.body}`).digest('hex')).toBe(v1);
    const event = JSON.parse(mine[1]!.body);
    expect(event).toMatchObject({ type: 'inventory.changed', businessId: owner.tenantId, data: { lines: [{ sku: 'A-1', onHand: 4, quantityDelta: 4 }] } });

    // A failing endpoint: kept pending with the error, then retried on request.
    sent.length = 0;
    answer = 500;
    await hub.post(`/webhooks/${endpoint.id}/test`).expect(200);
    await dispatcher.deliverDue();
    const deliveries = (await hub.get(`/webhooks/${endpoint.id}/deliveries`).expect(200)).body;
    expect(deliveries[0]).toMatchObject({ type: 'webhook.test', status: 'pending', attempts: 1, responseStatus: 500, lastError: 'Responded 500' });
    answer = 200;
    await hub.post(`/webhooks/deliveries/${deliveries[0].id}/retry`).expect(200);
    await dispatcher.deliverDue();
    expect((await hub.get(`/webhooks/${endpoint.id}/deliveries`).expect(200)).body[0]).toMatchObject({ status: 'delivered', responseStatus: 200 });
    const listed = (await owner.get('/webhooks').expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ url: 'https://hub.example.com/ample', active: true, pending: 0, failed: 0 });
    expect(listed[0].lastDeliveredAt).toBeTruthy();

    // Rotating the secret: new deliveries are signed with the new one.
    const { secret } = (await owner.post(`/webhooks/${endpoint.id}/rotate-secret`).expect(200)).body;
    sent.length = 0;
    await hub.post(`/webhooks/${endpoint.id}/test`).expect(200);
    await dispatcher.deliverDue();
    const [t2, s2] = sent[0]!.headers['Ample-Signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(createHmac('sha256', secret).update(`${t2}.${sent[0]!.body}`).digest('hex')).toBe(s2);
  });

  it('refuses to send webhooks to private networks', async () => {
    expect(['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.9', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
    const send = safeWebhookFetch(loadConfig({ DATABASE_URL: 'postgres://x/y', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'test-secret-test-secret-test-secret-123' }));
    await expect(send('https://127.0.0.1/hook', { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(/private network/);
  });
});

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ApiClient, CatalogIndex, downloadCatalog, MemoryEntryStore, SyncEngine } from '@pos/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, unique } from './helpers';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createTestApp();
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app.close();
});

/** Wraps fetch so a test can cut the network or drop responses after the server handled them. */
function flakyNetwork() {
  const net = { offline: false, dropResponses: false };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (net.offline) throw new TypeError('Network request failed');
    const res = await fetch(input, init);
    if (net.dropResponses) throw new TypeError('Connection reset by peer');
    return res;
  }) as typeof fetch;
  return { net, impl };
}

async function handheldSetup() {
  const owner = await Client.signIn(app);
  const tenantId = await owner.createBusiness();
  await owner.put('/modules/catalog', { enabled: true }).expect(200);
  await owner.put('/modules/inventory', { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Back room', timezone: 'UTC' }).expect(201)).body;
  const { credential } = (await owner.post('/devices', { locationId: location.id, name: 'Scanner', kind: 'handheld' }).expect(201)).body;
  const code = unique('MUG');
  await owner.post('/catalog/products', { name: 'Mug', variants: [{ priceMinor: 900, barcodes: [code] }] }).expect(201);
  await owner.post('/inventory/receipts', { locationId: location.id, lines: [{ variantId: (await owner.get(`/catalog/lookup?code=${code}`)).body.id, quantity: 10 }] }).expect(201);

  const staff = await owner.invite(await Client.signIn(app), 'staff');
  const { net, impl } = flakyNetwork();
  const api = new ApiClient({ baseUrl, token: staff.token, tenantId, deviceCredential: credential, fetch: impl });
  const count = await api.post<{ id: string }>('/inventory/counts', { locationId: location.id, name: 'Handheld count' });
  return { owner, staff, api, net, code, count, location, credential };
}

describe('offline counting against the real API', () => {
  it('scans offline from a downloaded catalog and syncs exactly once', async () => {
    const { owner, api, net, code, count } = await handheldSetup();
    const index = new CatalogIndex(await downloadCatalog(api));
    const engine = new SyncEngine(new MemoryEntryStore(), api);

    net.offline = true;
    const mug = index.find(code)!;
    expect(mug.productName).toBe('Mug');
    for (const quantity of [3, 4]) {
      await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity });
    }
    expect((await engine.flush()).stopped).toBe('offline');

    // Back online, but the first response is lost after the server stored the entries.
    net.offline = false;
    net.dropResponses = true;
    expect((await engine.flush()).stopped).toBe('offline');
    net.dropResponses = false;
    expect(await engine.flush()).toEqual({ sent: 2, failed: 0 });

    const review = (await owner.get(`/inventory/counts/${count.id}`).expect(200)).body;
    expect(review.lines).toEqual([expect.objectContaining({ counted: 7, expected: 10, discrepancy: -3 })]);
  });

  it('voids entries on the server and keeps local-only undos local', async () => {
    const { owner, api, code, count } = await handheldSetup();
    const engine = new SyncEngine(new MemoryEntryStore(), api);
    const mug = new CatalogIndex(await downloadCatalog(api)).find(code)!;

    const kept = await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 6 });
    const mistake = await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 60 });
    await engine.flush();
    await engine.void(mistake.id);
    const neverSent = await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 99 });
    await engine.void(neverSent.id);
    expect(await engine.flush()).toEqual({ sent: 1, failed: 0 });

    const entries = (await owner.get(`/inventory/counts/${count.id}/entries`).expect(200)).body as { id: string; voidedAt: string | null }[];
    expect(entries.map((e) => [e.id, e.voidedAt !== null]).sort()).toEqual([[kept.id, false], [mistake.id, true]].sort());
  });

  it('marks entries failed once the count is submitted elsewhere', async () => {
    const { owner, api, code, count } = await handheldSetup();
    const engine = new SyncEngine(new MemoryEntryStore(), api);
    const mug = new CatalogIndex(await downloadCatalog(api)).find(code)!;
    await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 1 });
    await engine.flush();
    await owner.post(`/inventory/counts/${count.id}/submit`).expect(201);

    await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 1 });
    expect(await engine.flush()).toEqual({ sent: 0, failed: 1 });
    expect(await engine.status(count.id)).toEqual({ pending: 0, failed: 1 });
  });

  it('stops syncing when the device is revoked, keeping its entries', async () => {
    const { owner, api, code, count, credential } = await handheldSetup();
    const engine = new SyncEngine(new MemoryEntryStore(), api);
    const mug = new CatalogIndex(await downloadCatalog(api)).find(code)!;
    await engine.record({ id: randomUUID(), countId: count.id, variantId: mug.id, label: 'Mug', quantity: 2 });
    await owner.post(`/devices/${credential.split('.')[0]}/revoke`).expect(201);
    expect((await engine.flush()).stopped).toBe('unauthorized');
    expect(await engine.status(count.id)).toEqual({ pending: 1, failed: 0 });
  });
});

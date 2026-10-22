import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDatabaseUrl, Client, createTestApp, unique } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

interface Store {
  owner: Client;
  storeId: string;
  warehouseId: string;
  /** "T-shirt" variants: Small and Large. */
  small: string;
  large: string;
}

async function setupStore(): Promise<Store> {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  await owner.put('/modules/catalog', { enabled: true }).expect(200);
  await owner.put('/modules/inventory', { enabled: true }).expect(200);
  const store = await owner.post('/locations', { name: 'Store', timezone: 'UTC' }).expect(201);
  const warehouse = await owner.post('/locations', { name: 'Warehouse', kind: 'warehouse', timezone: 'UTC' }).expect(201);
  const product = await owner
    .post('/catalog/products', {
      name: 'T-shirt',
      category: 'Apparel',
      variants: [
        { name: 'Small', sku: unique('TS-S'), priceMinor: 2000, barcodes: [unique('0001')] },
        { name: 'Large', sku: unique('TS-L'), priceMinor: 2200 },
      ],
    })
    .expect(201);
  return {
    owner,
    storeId: store.body.id,
    warehouseId: warehouse.body.id,
    small: product.body.variants[0].id,
    large: product.body.variants[1].id,
  };
}

async function onHand(client: Client, locationId: string, variantId: string): Promise<number> {
  const res = await client.get(`/inventory/levels?locationId=${locationId}`).expect(200);
  return res.body.levels.find((l: { variantId: string }) => l.variantId === variantId)?.onHand ?? 0;
}

describe('catalog', () => {
  it('requires the catalog module to be enabled', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    await owner.get('/catalog/products').expect(403);
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    await owner.get('/catalog/products').expect(200);
  });

  it('creates products with variants and finds them by name, SKU and barcode', async () => {
    const { owner } = await setupStore();
    const sku = unique('MUG');
    const code = unique('7890');
    const created = await owner
      .post('/catalog/products', {
        name: 'Coffee mug',
        variants: [{ sku, priceMinor: 1299, costMinor: 400, barcodes: [code, `${code}-alt`] }],
      })
      .expect(201);
    expect(created.body.version).toBe(1);
    expect(created.body.variants).toEqual([
      expect.objectContaining({ name: 'Default', sku, priceMinor: 1299, costMinor: 400, barcodes: [code, `${code}-alt`] }),
    ]);

    for (const search of ['coffee', sku.toLowerCase(), code]) {
      const res = await owner.get(`/catalog/products?search=${encodeURIComponent(search)}`).expect(200);
      expect(res.body.products.map((p: { name: string }) => p.name)).toEqual(['Coffee mug']);
    }

    const byBarcode = await owner.get(`/catalog/lookup?code=${code}`).expect(200);
    expect(byBarcode.body).toMatchObject({ sku, product: { name: 'Coffee mug' } });
    const bySku = await owner.get(`/catalog/lookup?code=${sku.toLowerCase()}`).expect(200);
    expect(bySku.body.id).toBe(byBarcode.body.id);
    await owner.get('/catalog/lookup?code=nothing-here').expect(404);

    await owner.patch(`/catalog/products/${created.body.id}`, { version: 1, status: 'archived' }).expect(200);
    await owner.get(`/catalog/lookup?code=${code}`).expect(404);
  });

  it('rejects duplicate SKUs and barcodes within a business', async () => {
    const { owner } = await setupStore();
    const sku = unique('DUP');
    const code = unique('555');
    await owner.post('/catalog/products', { name: 'A', variants: [{ sku, priceMinor: 100, barcodes: [code] }] }).expect(201);
    await owner.post('/catalog/products', { name: 'B', variants: [{ sku: sku.toUpperCase(), priceMinor: 100 }] }).expect(409);
    await owner.post('/catalog/products', { name: 'C', variants: [{ priceMinor: 100, barcodes: [code] }] }).expect(409);
    await owner
      .post('/catalog/products', { name: 'D', variants: [{ priceMinor: 1, barcodes: ['x1'] }, { priceMinor: 1, barcodes: ['x1'] }] })
      .expect(409);
    await owner.post('/catalog/products', { name: 'E', variants: [{ priceMinor: -1 }] }).expect(400);
    await owner.post('/catalog/products', { name: 'F', variants: [] }).expect(400);

    // Another business may use the same codes.
    const other = await setupStore();
    await other.owner.post('/catalog/products', { name: 'A', variants: [{ sku, priceMinor: 100, barcodes: [code] }] }).expect(201);
  });

  it('detects conflicting edits with versions', async () => {
    const { owner, small } = await setupStore();
    const variant = (await owner.get(`/catalog/lookup?code=${(await owner.get('/catalog/products').expect(200)).body.products[0].variants[0].sku}`)).body;
    expect(variant.id).toBe(small);

    const first = await owner.patch(`/catalog/variants/${small}`, { version: 1, priceMinor: 2500, barcodes: ['NEW-1'] }).expect(200);
    expect(first.body).toMatchObject({ version: 2, priceMinor: 2500, barcodes: ['NEW-1'] });

    const stale = await owner.patch(`/catalog/variants/${small}`, { version: 1, priceMinor: 1 }).expect(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.current).toMatchObject({ version: 2, priceMinor: 2500 });
    await owner.patch(`/catalog/variants/${randomUUID()}`, { version: 1, priceMinor: 1 }).expect(404);
  });

  it('lets staff read but not edit, and hides other businesses’ products', async () => {
    const { owner, small } = await setupStore();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const list = await staff.get('/catalog/products').expect(200);
    expect(list.body.products).toHaveLength(1);
    await staff.post('/catalog/products', { name: 'X', variants: [{ priceMinor: 1 }] }).expect(403);

    const outsider = await setupStore();
    const productId = list.body.products[0].id;
    await outsider.owner.get(`/catalog/products/${productId}`).expect(404);
    await outsider.owner.patch(`/catalog/variants/${small}`, { version: 1, priceMinor: 1 }).expect(404);
  });
});

describe('inventory ledger', () => {
  it('receives, adjusts and transfers stock with matching movements', async () => {
    const { owner, storeId, warehouseId, small } = await setupStore();
    await owner.post('/inventory/receipts', { locationId: warehouseId, lines: [{ variantId: small, quantity: 10 }] }).expect(201);
    await owner
      .post('/inventory/transfers', { fromLocationId: warehouseId, toLocationId: storeId, lines: [{ variantId: small, quantity: 4 }] })
      .expect(201);
    await owner.post('/inventory/adjustments', { locationId: storeId, lines: [{ variantId: small, quantityDelta: -1 }] }).expect(400);
    await owner
      .post('/inventory/adjustments', { locationId: storeId, lines: [{ variantId: small, quantityDelta: -1 }], note: 'Damaged' })
      .expect(201);

    expect(await onHand(owner, warehouseId, small)).toBe(6);
    expect(await onHand(owner, storeId, small)).toBe(3);

    const history = await owner.get(`/inventory/movements?variantId=${small}`).expect(200);
    expect(history.body.movements.map((m: { reason: string; quantityDelta: number }) => [m.reason, m.quantityDelta])).toEqual([
      ['adjustment', -1],
      ['transfer_in', 4],
      ['transfer_out', -4],
      ['receive', 10],
    ]);
  });

  it('applies a retried request only once', async () => {
    const { owner, storeId, small } = await setupStore();
    const body = { locationId: storeId, lines: [{ variantId: small, quantity: 5 }], idempotencyKey: randomUUID() };
    const first = await owner.post('/inventory/receipts', body).expect(201);
    const retry = await owner.post('/inventory/receipts', body).expect(201);
    expect(first.body.replayed).toBe(false);
    expect(retry.body).toMatchObject({ replayed: true, operationId: first.body.operationId });
    expect(await onHand(owner, storeId, small)).toBe(5);

    await owner
      .post('/inventory/adjustments', { ...body, lines: [{ variantId: small, quantityDelta: 1 }], note: 'x' })
      .expect(400);
  });

  it('keeps balances correct under concurrent writes', async () => {
    const { owner, storeId, small } = await setupStore();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        owner.post('/inventory/receipts', { locationId: storeId, lines: [{ variantId: small, quantity: 1 }] }).expect(201),
      ),
    );
    expect(await onHand(owner, storeId, small)).toBe(20);
  });

  it('refuses stock movements for untracked items and archived locations', async () => {
    const { owner, storeId } = await setupStore();
    const service = await owner
      .post('/catalog/products', { name: 'Gift wrap', variants: [{ priceMinor: 300, trackInventory: false }] })
      .expect(201);
    await owner
      .post('/inventory/receipts', { locationId: storeId, lines: [{ variantId: service.body.variants[0].id, quantity: 1 }] })
      .expect(400);

    const closed = await owner.post('/locations', { name: 'Closed', timezone: 'UTC' }).expect(201);
    await owner.patch(`/locations/${closed.body.id}`, { archived: true }).expect(200);
    const product = (await owner.get('/catalog/products').expect(200)).body.products.find((p: { name: string }) => p.name === 'T-shirt');
    await owner
      .post('/inventory/receipts', { locationId: closed.body.id, lines: [{ variantId: product.variants[0].id, quantity: 1 }] })
      .expect(404);
  });

  it('only lets balances change through movements, at the database level', async () => {
    const { owner, storeId, small } = await setupStore();
    await owner.post('/inventory/receipts', { locationId: storeId, lines: [{ variantId: small, quantity: 3 }] }).expect(201);
    const sql = postgres(appDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await expect(sql`update stock_levels set on_hand = 999`).rejects.toThrow(/permission denied/);
      await expect(sql`update stock_movements set quantity_delta = 999`).rejects.toThrow(/permission denied/);
      await expect(sql`delete from stock_movements`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.end();
    }
    expect(await onHand(owner, storeId, small)).toBe(3);
  });

  it('enforces inventory permissions', async () => {
    const { owner, storeId, small } = await setupStore();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get(`/inventory/levels?locationId=${storeId}`).expect(200);
    await staff.post('/inventory/receipts', { locationId: storeId, lines: [{ variantId: small, quantity: 1 }] }).expect(403);
  });
});

describe('count sessions', () => {
  it('adjusts to the count without mistaking sales during the count for shrinkage', async () => {
    const { owner, storeId, small, large } = await setupStore();
    await owner
      .post('/inventory/receipts', { locationId: storeId, lines: [{ variantId: small, quantity: 10 }, { variantId: large, quantity: 4 }] })
      .expect(201);

    const session = (await owner.post('/inventory/counts', { locationId: storeId, name: 'Weekly' }).expect(201)).body;

    // A sale happens before Small is counted: expected becomes 9.
    await owner
      .post('/inventory/adjustments', { locationId: storeId, lines: [{ variantId: small, quantityDelta: -1 }], note: 'sale' })
      .expect(201);
    // Two people count Small in different aisles (7 total); one entry is resent by a flaky device.
    const e1 = randomUUID();
    await owner.post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: e1, variantId: small, quantity: 5 }] }).expect(201);
    const resend = await owner
      .post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: e1, variantId: small, quantity: 5 }, { id: randomUUID(), variantId: small, quantity: 2 }] })
      .expect(201);
    expect(resend.body).toEqual({ accepted: 1, duplicates: 1 });
    // Large: a mistaken entry is voided and replaced.
    const wrong = randomUUID();
    await owner
      .post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: wrong, variantId: large, quantity: 40 }, { id: randomUUID(), variantId: large, quantity: 4 }] })
      .expect(201);
    await owner.post(`/inventory/counts/${session.id}/entries/${wrong}/void`).expect(201);

    // Another sale after Small was counted must not affect its discrepancy.
    await owner
      .post('/inventory/adjustments', { locationId: storeId, lines: [{ variantId: small, quantityDelta: -1 }], note: 'sale' })
      .expect(201);

    const review = (await owner.get(`/inventory/counts/${session.id}`).expect(200)).body;
    const line = (id: string) => review.lines.find((l: { variantId: string }) => l.variantId === id);
    expect(line(small)).toMatchObject({ counted: 7, expected: 9, discrepancy: -2, onHandNow: 8 });
    expect(line(large)).toMatchObject({ counted: 4, expected: 4, discrepancy: 0 });

    await owner.post(`/inventory/counts/${session.id}/approve`).expect(409);
    await owner.post(`/inventory/counts/${session.id}/submit`).expect(201);
    await owner
      .post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: randomUUID(), variantId: small, quantity: 1 }] })
      .expect(409);
    const approved = (await owner.post(`/inventory/counts/${session.id}/approve`).expect(201)).body;
    expect(approved.status).toBe('approved');
    expect(approved.operationId).toBeTruthy();

    // Physically 7, then one sold after counting: 6 on hand.
    expect(await onHand(owner, storeId, small)).toBe(6);
    expect(await onHand(owner, storeId, large)).toBe(4);
    const history = await owner.get(`/inventory/movements?variantId=${small}&limit=1`).expect(200);
    expect(history.body.movements[0]).toMatchObject({ reason: 'count_adjustment', quantityDelta: -2, referenceId: session.id });

    // The approved count still shows what was found.
    const after = (await owner.get(`/inventory/counts/${session.id}`).expect(200)).body;
    expect(after.totals).toEqual({ items: 2, withDiscrepancy: 1, netUnits: -2 });
    await owner.post(`/inventory/counts/${session.id}/approve`).expect(409);
  });

  it('separates counting from approving', async () => {
    const { owner, storeId, small } = await setupStore();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const session = (await staff.post('/inventory/counts', { locationId: storeId, name: 'Spot check' }).expect(201)).body;
    await staff.post(`/inventory/counts/${session.id}/submit`).expect(400);
    await staff
      .post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: randomUUID(), variantId: small, quantity: 3 }] })
      .expect(201);
    await staff.post(`/inventory/counts/${session.id}/submit`).expect(201);
    await staff.post(`/inventory/counts/${session.id}/approve`).expect(403);
    await staff.post(`/inventory/counts/${session.id}/reopen`).expect(201);
    await staff.post(`/inventory/counts/${session.id}/submit`).expect(201);

    const manager = await owner.invite(await Client.signIn(app), 'manager');
    await manager.post(`/inventory/counts/${session.id}/approve`).expect(201);
    expect(await onHand(owner, storeId, small)).toBe(3);
  });

  it('can be cancelled without touching stock', async () => {
    const { owner, storeId, small } = await setupStore();
    const session = (await owner.post('/inventory/counts', { locationId: storeId, name: 'Oops' }).expect(201)).body;
    await owner
      .post(`/inventory/counts/${session.id}/entries`, { entries: [{ id: randomUUID(), variantId: small, quantity: 9 }] })
      .expect(201);
    await owner.post(`/inventory/counts/${session.id}/cancel`).expect(201);
    await owner.post(`/inventory/counts/${session.id}/submit`).expect(409);
    expect(await onHand(owner, storeId, small)).toBe(0);
  });
});

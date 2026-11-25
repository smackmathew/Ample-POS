import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const QB_ITEMS = [
  'Item Number,Item Name,Item Description,Attribute,Size,Department Name,Regular Price,Average Unit Cost,UPC,Alternate Lookup,Qty 1',
  '1001,Rain Jacket,Rain jacket,Navy,L,Outerwear,129.00,54.25,012345678905,RJ-NAVY-L,8',
  '1002,Rain Jacket,Rain jacket,Navy,M,Outerwear,129.00,54.25,012345678912,,3',
  '1003,Gift wrap,,,,Services,3.00,,,,',
  '1004,Mug,,,,Kitchen,,2.10,,,5',
].join('\r\n');

async function shop() {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  for (const m of ['catalog', 'inventory', 'pos', 'customers', 'purchasing']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const store = (await owner.post('/locations', { name: 'Main', timezone: 'UTC' }).expect(201)).body;
  return { owner, store };
}

const onHand = async (owner: Client, locationId: string) =>
  Object.fromEntries(
    ((await owner.get(`/inventory/levels?locationId=${locationId}`).expect(200)).body.levels as { sku: string | null; onHand: number }[])
      .filter((l) => l.sku)
      .map((l) => [l.sku, l.onHand]),
  );

describe('importing from QuickBooks POS', () => {
  it('previews, imports items with stock, updates on a second import, and undoes both', async () => {
    const { owner, store } = await shop();
    const preview = (await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items.csv', csv: QB_ITEMS, locationId: store.id }).expect(201)).body;
    expect(preview.counts).toMatchObject({ rows: 4, create: 3, update: 0, error: 1 });
    expect(preview.batch.mapping).toMatchObject({ sku: 'Item Number', price: 'Regular Price', onHand: 'Qty 1' });
    expect(preview.planned.find((p: { line: number }) => p.line === 5)).toMatchObject({ action: 'error', errors: ['No price'] });
    // Nothing is in the catalog until the import runs.
    expect((await owner.get('/catalog/products').expect(200)).body.products ?? (await owner.get('/catalog/products').expect(200)).body).toHaveLength(0);

    const result = (await owner.post(`/imports/${preview.batch.id}/commit`).expect(200)).body;
    expect(result).toMatchObject({ created: 3, updated: 0, failed: 1, stockSet: 2 });
    expect(result.failures).toEqual([{ line: 5, error: 'No price' }]);

    // Matrix items became one product with two variants; barcodes and stock came along.
    const jacket = (await owner.get('/catalog/lookup?code=RJ-NAVY-L').expect(200)).body;
    expect(JSON.stringify(jacket)).toContain('Navy / L');
    const products = (await owner.get('/catalog/products?limit=50').expect(200)).body;
    const list = products.products ?? products;
    expect(list.map((p: { name: string }) => p.name).sort()).toEqual(['Gift wrap', 'Rain Jacket']);
    expect(list.find((p: { name: string }) => p.name === 'Rain Jacket').variants).toHaveLength(2);
    expect(await onHand(owner, store.id)).toMatchObject({ '1001': 8, '1002': 3 });

    // A second export from QuickBooks POS with new prices and counts updates the same items.
    const again = QB_ITEMS.replace('129.00,54.25,012345678905,RJ-NAVY-L,8', '139.00,54.25,012345678905,RJ-NAVY-L,6');
    const second = (await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items-2.csv', csv: again, locationId: store.id }).expect(201)).body;
    expect(second.counts).toMatchObject({ create: 0, update: 3 });
    expect((await owner.post(`/imports/${second.batch.id}/commit`).expect(200)).body).toMatchObject({ created: 0, updated: 3, stockSet: 1 });
    expect(await onHand(owner, store.id)).toMatchObject({ '1001': 6 });

    // Undo the second import: the price and the count go back.
    await owner.post(`/imports/${second.batch.id}/undo`).expect(200);
    expect(JSON.stringify((await owner.get('/catalog/lookup?code=1001').expect(200)).body)).toContain('12900');
    expect(await onHand(owner, store.id)).toMatchObject({ '1001': 8 });
    await owner.post(`/imports/${second.batch.id}/undo`).expect(409);

    // Undo the first: the products are archived, their barcodes freed, stock back to zero.
    await owner.post(`/imports/${preview.batch.id}/undo`).expect(200);
    const after = (await owner.get('/catalog/products').expect(200)).body;
    expect(after.products ?? after).toHaveLength(0);
    await owner.get('/catalog/lookup?code=RJ-NAVY-L').expect(404);
    expect(await onHand(owner, store.id)).toMatchObject({ '1001': 0, '1002': 0 });

    const history = (await owner.get('/imports').expect(200)).body;
    expect(history.map((h: { fileName: string; status: string }) => [h.fileName, h.status])).toEqual([
      ['items-2.csv', 'undone'],
      ['items.csv', 'undone'],
    ]);
  });

  it('lets the columns be re-mapped before importing', async () => {
    const { owner } = await shop();
    const csv = 'Code,Title,Retail,Sale\nA1,Apron,20.00,15.00';
    const preview = (await owner.post('/imports', { kind: 'products', source: 'other', fileName: 'x.csv', csv }).expect(201)).body;
    expect(preview.batch.mapping).toMatchObject({ sku: 'Code', name: 'Title', price: 'Retail' });
    const remapped = (await owner.put(`/imports/${preview.batch.id}/mapping`, { mapping: { ...preview.batch.mapping, price: 'Sale' } }).expect(200)).body;
    expect(remapped.batch.mapping.price).toBe('Sale');
    await owner.put(`/imports/${preview.batch.id}/mapping`, { mapping: { price: 'Nope' } }).expect(400);
    await owner.post(`/imports/${preview.batch.id}/commit`).expect(200);
    expect(JSON.stringify((await owner.get('/catalog/lookup?code=A1').expect(200)).body)).toContain('1500');
  });

  it('imports customers and vendors, matching existing ones', async () => {
    const { owner } = await shop();
    await owner.post('/customers', { name: 'Ana L', email: 'ana@example.com' }).expect(201);
    const customers = 'First Name,Last Name,Company,EMail,Phone 1,Notes\nAna,Lopez,,ANA@example.com,,VIP\nBen,Ortiz,,ben@example.com,(312) 555-0199,\n,,,,,Just a note';
    const pc = (await owner.post('/imports', { kind: 'customers', source: 'qbpos', fileName: 'customers.csv', csv: customers }).expect(201)).body;
    expect(pc.counts).toMatchObject({ create: 1, update: 1, error: 1 });
    expect((await owner.post(`/imports/${pc.batch.id}/commit`).expect(200)).body).toMatchObject({ created: 1, updated: 1, failed: 1 });
    const list = (await owner.get('/customers').expect(200)).body;
    expect(list.map((c: { name: string }) => c.name).sort()).toEqual(['Ana Lopez', 'Ben Ortiz']);
    await owner.post(`/imports/${pc.batch.id}/undo`).expect(200);
    expect((await owner.get('/customers').expect(200)).body.map((c: { name: string }) => c.name)).toEqual(['Ana L']);

    const vendors = 'Company,First Name,Last Name,EMail,Phone 1\nAcme Supply,Jo,Park,jo@acme.example,555-123-4567';
    const pv = (await owner.post('/imports', { kind: 'suppliers', source: 'qbpos', fileName: 'vendors.csv', csv: vendors }).expect(201)).body;
    await owner.post(`/imports/${pv.batch.id}/commit`).expect(200);
    expect((await owner.get('/suppliers').expect(200)).body[0]).toMatchObject({ name: 'Acme Supply', contactName: 'Jo Park' });
  });

  it('exports in a format that imports back unchanged, and is for owners only', async () => {
    const { owner, store } = await shop();
    const first = (await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items.csv', csv: QB_ITEMS, locationId: store.id }).expect(201)).body;
    await owner.post(`/imports/${first.batch.id}/commit`).expect(200);
    const exported = await owner.get(`/exports/products.csv?locationId=${store.id}`).expect(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain('ample-pos-products-');
    expect(exported.text).toContain('SKU,Product,Variant,Category,Price,Cost,Barcodes,On hand');
    expect(exported.text).toContain('1001,Rain Jacket,Navy / L,Outerwear,129.00,54.25,012345678905 RJ-NAVY-L,8');

    const back = (await owner.post('/imports', { kind: 'products', source: 'ample', fileName: 'export.csv', csv: exported.text, locationId: store.id }).expect(201)).body;
    expect(back.counts).toMatchObject({ create: 0, update: 3, error: 0 });

    const staff = await owner.invite(await Client.signIn(app), 'manager');
    await staff.get('/imports').expect(403);
    await staff.get('/exports/customers.csv').expect(403);
  });
});

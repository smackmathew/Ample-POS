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
  for (const m of ['catalog', 'inventory', 'pos', 'customers', 'purchasing', 'gift-cards', 'loyalty', 'reporting'])
    await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
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
    const preview = (
      await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items.csv', csv: QB_ITEMS, locationId: store.id }).expect(201)
    ).body;
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
    const second = (await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items-2.csv', csv: again, locationId: store.id }).expect(201))
      .body;
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
    const customers =
      'First Name,Last Name,Company,EMail,Phone 1,Notes\nAna,Lopez,,ANA@example.com,,VIP\nBen,Ortiz,,ben@example.com,(312) 555-0199,\n,,,,,Just a note';
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
    const first = (await owner.post('/imports', { kind: 'products', source: 'qbpos', fileName: 'items.csv', csv: QB_ITEMS, locationId: store.id }).expect(201))
      .body;
    await owner.post(`/imports/${first.batch.id}/commit`).expect(200);
    const exported = await owner.get(`/exports/products.csv?locationId=${store.id}`).expect(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.headers['content-disposition']).toContain('ample-pos-products-');
    expect(exported.text).toContain('SKU,Product,Variant,Category,Price,Cost,Barcodes,On hand');
    expect(exported.text).toContain('1001,Rain Jacket,Navy / L,Outerwear,129.00,54.25,012345678905 RJ-NAVY-L,8');

    const back = (
      await owner.post('/imports', { kind: 'products', source: 'ample', fileName: 'export.csv', csv: exported.text, locationId: store.id }).expect(201)
    ).body;
    expect(back.counts).toMatchObject({ create: 0, update: 3, error: 0 });

    const staff = await owner.invite(await Client.signIn(app), 'manager');
    await staff.get('/imports').expect(403);
    await staff.get('/exports/customers.csv').expect(403);
  });

  it('imports gift card balances, loyalty points and sales history, and undoes them', async () => {
    const { owner, store } = await shop();
    // An existing card in Ample POS gets set to the file's balance.
    const existing = (await owner.post('/gift-cards', { code: 'EXIST0000001', amountMinor: 1000, note: 'Make-good' }).expect(201)).body;
    const cards = 'Gift Card #,Balance\nQBGC-0000-0001,25.00\nexist0000001,40.00\nQBGC00000001,1.00\nX1,3';
    const pg = (await owner.post('/imports', { kind: 'gift_cards', source: 'qbpos', fileName: 'cards.csv', csv: cards }).expect(201)).body;
    expect(pg.counts).toMatchObject({ create: 1, update: 1, error: 2 });
    expect((await owner.post(`/imports/${pg.batch.id}/commit`).expect(200)).body).toMatchObject({ created: 1, updated: 1, failed: 2 });
    const balance = async (code: string) => (await owner.get(`/gift-cards/balance?code=${code}`).expect(200)).body;
    expect(await balance('QBGC00000001')).toMatchObject({ balanceMinor: 2500, status: 'active' });
    expect(await balance('EXIST0000001')).toMatchObject({ balanceMinor: 4000 });
    await owner.post(`/imports/${pg.batch.id}/undo`).expect(200);
    expect(await balance('QBGC00000001')).toMatchObject({ balanceMinor: 0, status: 'void' });
    expect(await balance('EXIST0000001')).toMatchObject({ balanceMinor: 1000 });
    expect(existing.balanceMinor).toBe(1000);

    // Points are matched to customers by email, phone or name.
    const ana = (await owner.post('/customers', { name: 'Ana Lopez', email: 'ana@example.com' }).expect(201)).body;
    const ben = (await owner.post('/customers', { name: 'Ben Ortiz', phone: '(312) 555-0199' }).expect(201)).body;
    const points = 'First Name,Last Name,EMail,Phone 1,Points\nAna,,ANA@example.com,,120\nBenjamin,,,312-555-0199,40\nCara,,,,10';
    const pl = (await owner.post('/imports', { kind: 'loyalty', source: 'qbpos', fileName: 'points.csv', csv: points }).expect(201)).body;
    expect(pl.counts).toMatchObject({ update: 2, error: 1 });
    await owner.post(`/imports/${pl.batch.id}/commit`).expect(200);
    expect((await owner.get(`/loyalty/customers/${ana.id}`).expect(200)).body.balance).toBe(120);
    expect((await owner.get(`/loyalty/customers/${ben.id}`).expect(200)).body.balance).toBe(40);
    await owner.post(`/imports/${pl.batch.id}/undo`).expect(200);
    expect((await owner.get(`/loyalty/customers/${ana.id}`).expect(200)).body.balance).toBe(0);

    // Sales history shows in reports and on the customer, without touching stock.
    const history = [
      'Receipt #,Date,Item Number,Item Name,Qty,Ext Price,Tax,Customer,EMail',
      '2001,3/14/2024,1001,Rain Jacket,2,258.00,20.64,Ana Lopez,ana@example.com',
      '2001,3/14/2024,,Gift wrap,1,3.00,0.24,Ana Lopez,ana@example.com',
      '2002,3/15/2024,,Mug,1,(4.00),,,',
    ].join('\n');
    const noPlace = (await owner.post('/imports', { kind: 'sales', source: 'qbpos', fileName: 'sales.csv', csv: history }).expect(201)).body;
    expect(noPlace.planned[0].errors).toContain('Choose the location these sales were made at');
    await owner.post(`/imports/${noPlace.batch.id}/commit`).expect(400);
    const ps = (await owner.post('/imports', { kind: 'sales', source: 'qbpos', fileName: 'sales.csv', csv: history, locationId: store.id }).expect(201)).body;
    expect(ps.counts).toMatchObject({ create: 3, error: 0 });
    expect((await owner.post(`/imports/${ps.batch.id}/commit`).expect(200)).body).toMatchObject({ created: 3, receipts: 2, linkedCustomers: 2 });
    const report = (await owner.get('/reports/sales?from=2024-03-01&to=2024-03-31').expect(200)).body;
    expect(report.totals).toMatchObject({ salesCount: 2, grossMinor: 25800 + 2064 + 300 + 24 - 400, importedMinor: 25800 + 2064 + 300 + 24 - 400 });
    expect(report.topProducts[0]).toMatchObject({ description: 'Rain Jacket', quantity: 2, revenueMinor: 25800 });
    const customer = (await owner.get(`/customers/${ana.id}`).expect(200)).body;
    expect(customer.importedHistory).toEqual([
      { receipt: '2001', soldOn: '2024-03-14', items: 3, totalMinor: 25800 + 2064 + 300 + 24, description: 'Rain Jacket, Gift wrap' },
    ]);
    await owner.post(`/imports/${ps.batch.id}/undo`).expect(200);
    expect((await owner.get('/reports/sales?from=2024-03-01&to=2024-03-31').expect(200)).body.totals.salesCount).toBe(0);
  });
});

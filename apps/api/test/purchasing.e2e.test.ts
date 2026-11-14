import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { Client, createTestApp, unique } from './helpers';

const outbox: { to: string[]; subject: string; text: string }[] = [];
const fakeResend = (async (_url: string, init: RequestInit) => {
  outbox.push(JSON.parse(String(init.body)));
  return new Response('{"id":"email_1"}', { status: 200 });
}) as unknown as typeof fetch;

let app: INestApplication;
let quiet: INestApplication;

beforeAll(async () => {
  app = await createTestApp({ env: { RESEND_API_KEY: 're_test' }, providers: [[MAIL_FETCH, fakeResend]] });
  quiet = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await quiet.close();
});

/** A shop with beans and mugs (tracked) and a gift wrap service (not tracked), and a supplier. */
async function shop(a: INestApplication = app, modules = ['catalog', 'inventory', 'purchasing']) {
  const owner = await Client.signIn(a);
  await owner.createBusiness('Corner Cafe');
  for (const m of modules) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago' }).expect(201)).body;
  const product = async (name: string, track = true) =>
    (await owner.post('/catalog/products', { name, variants: [{ priceMinor: 1500, sku: unique(name.slice(0, 3)), trackInventory: track }] }).expect(201)).body.variants[0].id as string;
  const [beans, mugs, wrap] = [await product('Beans'), await product('Mug'), await product('Gift wrap', false)];
  const supplier = (await owner.post('/suppliers', { name: 'Roastery Co', email: 'Orders@Roastery.example', contactName: 'Sam' }).expect(201)).body;
  const onHand = async (variantId: string) => {
    const { levels } = (await owner.get(`/inventory/levels?locationId=${location.id}`).expect(200)).body;
    return (levels.find((l: { variantId: string }) => l.variantId === variantId)?.onHand ?? 0) as number;
  };
  const draft = (lines: { variantId: string; quantity: number; unitCostMinor: number }[]) =>
    owner.post('/purchase-orders', { supplierId: supplier.id, locationId: location.id, lines });
  return { owner, location, beans, mugs, wrap, supplier, onHand, draft };
}

describe('purchase orders', () => {
  it('keeps a list of suppliers', async () => {
    const { owner, supplier } = await shop();
    expect(supplier).toMatchObject({ name: 'Roastery Co', email: 'orders@roastery.example', contactName: 'Sam' });
    await owner.post('/suppliers', { name: 'roastery co' }).expect(409);
    await owner.post('/suppliers', { name: 'Bad', email: 'nope' }).expect(400);
    await owner.patch(`/suppliers/${supplier.id}`, { archived: true }).expect(200);
    expect((await owner.get('/suppliers').expect(200)).body).toEqual([]);
    expect((await owner.get('/suppliers?archived=true').expect(200)).body).toHaveLength(1);
    await owner.post('/suppliers', { name: 'Roastery Co' }).expect(201); // the name is free again
  });

  it('drafts, edits and places an order', async () => {
    const { owner, beans, mugs, wrap, draft } = await shop();
    const po = (await draft([{ variantId: beans, quantity: 10, unitCostMinor: 800 }]).expect(201)).body;
    expect(po).toMatchObject({ reference: 'PO-1', status: 'draft', totalMinor: 8000, lines: [{ description: 'Beans', quantityOrdered: 10, onHand: 0 }] });
    expect((await draft([]).expect(201)).body.reference).toBe('PO-2');
    await draft([{ variantId: wrap, quantity: 1, unitCostMinor: 100 }]).expect(400); // not tracked
    await draft([
      { variantId: beans, quantity: 1, unitCostMinor: 1 },
      { variantId: beans, quantity: 1, unitCostMinor: 1 },
    ]).expect(400);

    const body = { supplierId: po.supplierId, locationId: po.locationId, expectedOn: '2026-12-01', lines: [{ variantId: beans, quantity: 12, unitCostMinor: 800 }, { variantId: mugs, quantity: 6, unitCostMinor: 450 }] };
    expect((await owner.put(`/purchase-orders/${po.id}`, body).expect(200)).body).toMatchObject({ totalMinor: 12300, expectedOn: '2026-12-01', lines: [{ quantityOrdered: 12 }, { quantityOrdered: 6 }] });
    const empty = (await owner.get('/purchase-orders?status=draft').expect(200)).body.find((o: { reference: string }) => o.reference === 'PO-2');
    await owner.post(`/purchase-orders/${empty.id}/order`, {}).expect(400);
    const placed = (await owner.post(`/purchase-orders/${po.id}/order`, {}).expect(200)).body;
    expect(placed).toMatchObject({ status: 'ordered', emailedTo: null });
    expect(placed.orderedAt).toBeTruthy();
    await owner.put(`/purchase-orders/${po.id}`, body).expect(409);
    expect((await owner.get('/purchase-orders?status=open').expect(200)).body.map((o: { reference: string }) => o.reference)).toEqual(['PO-2', 'PO-1']);
  });

  it('receives deliveries into stock, in parts, without counting a retry twice', async () => {
    const { owner, beans, mugs, onHand, draft } = await shop();
    const po = (await draft([{ variantId: beans, quantity: 10, unitCostMinor: 800 }, { variantId: mugs, quantity: 4, unitCostMinor: 450 }]).expect(201)).body;
    const [beansLine, mugsLine] = po.lines;
    await owner.post(`/purchase-orders/${po.id}/receive`, { id: randomUUID(), lines: [{ lineId: beansLine.id, quantity: 1 }] }).expect(409); // still a draft
    await owner.post(`/purchase-orders/${po.id}/order`, {}).expect(200);

    const first = { id: randomUUID(), lines: [{ lineId: beansLine.id, quantity: 6 }, { lineId: mugsLine.id, quantity: 0 }], note: 'Box 1 of 2' };
    const partial = (await owner.post(`/purchase-orders/${po.id}/receive`, first).expect(201)).body;
    expect(partial).toMatchObject({ status: 'partially_received', lines: [{ quantityReceived: 6, onHand: 6 }, { quantityReceived: 0 }], receipts: [{ units: 6, note: 'Box 1 of 2' }] });
    await owner.post(`/purchase-orders/${po.id}/receive`, first).expect(201); // retried
    expect(await onHand(beans)).toBe(6);

    // The rest arrives, with an extra mug thrown in.
    const done = (await owner.post(`/purchase-orders/${po.id}/receive`, { id: randomUUID(), lines: [{ lineId: beansLine.id, quantity: 4 }, { lineId: mugsLine.id, quantity: 5 }] }).expect(201)).body;
    expect(done.status).toBe('received');
    expect([await onHand(beans), await onHand(mugs)]).toEqual([10, 5]);
    await owner.post(`/purchase-orders/${po.id}/receive`, { id: randomUUID(), lines: [{ lineId: beansLine.id, quantity: 1 }] }).expect(409);

    // Costs follow what was paid; the stock history points at the order.
    const products = (await owner.get('/catalog/products').expect(200)).body.products;
    const cost = (id: string) => products.flatMap((p: { variants: { id: string; costMinor: number }[] }) => p.variants).find((v: { id: string }) => v.id === id).costMinor;
    expect([cost(beans), cost(mugs)]).toEqual([800, 450]);
    const { movements } = (await owner.get(`/inventory/movements?variantId=${beans}`).expect(200)).body;
    expect(movements.every((m: { reason: string; referenceType: string; referenceId: string }) => m.reason === 'receive' && m.referenceType === 'purchase_order' && m.referenceId === po.id)).toBe(true);
  });

  it('can skip updating costs, close a short order and cancel an unreceived one', async () => {
    const { owner, beans, draft } = await shop();
    const short = (await draft([{ variantId: beans, quantity: 10, unitCostMinor: 999 }]).expect(201)).body;
    await owner.post(`/purchase-orders/${short.id}/order`, {}).expect(200);
    await owner.post(`/purchase-orders/${short.id}/close`).expect(409); // nothing arrived: cancel it instead
    await owner.post(`/purchase-orders/${short.id}/receive`, { id: randomUUID(), lines: [{ lineId: short.lines[0].id, quantity: 7 }], updateCosts: false }).expect(201);
    await owner.post(`/purchase-orders/${short.id}/cancel`).expect(409);
    expect((await owner.post(`/purchase-orders/${short.id}/close`).expect(200)).body).toMatchObject({ status: 'received', lines: [{ quantityReceived: 7 }] });
    const products = (await owner.get('/catalog/products').expect(200)).body.products;
    expect(products.flatMap((p: { variants: { id: string; costMinor: number | null }[] }) => p.variants).find((v: { id: string }) => v.id === beans).costMinor).toBeNull();

    const never = (await draft([{ variantId: beans, quantity: 1, unitCostMinor: 1 }]).expect(201)).body;
    await owner.post(`/purchase-orders/${never.id}/order`, {}).expect(200);
    expect((await owner.post(`/purchase-orders/${never.id}/cancel`).expect(200)).body.status).toBe('canceled');
    await owner.post(`/purchase-orders/${never.id}/order`, {}).expect(409);
  });

  it('emails the order to the supplier', async () => {
    const { owner, beans, supplier, draft } = await shop();
    const po = (await draft([{ variantId: beans, quantity: 12, unitCostMinor: 800 }]).expect(201)).body;
    const placed = (await owner.post(`/purchase-orders/${po.id}/order`, { email: true, message: 'Usual delivery door, please.' }).expect(200)).body;
    expect(placed.emailedTo).toBe('orders@roastery.example');
    const mail = outbox.at(-1)!;
    expect(mail.to).toEqual(['orders@roastery.example']);
    expect(mail.subject).toBe('Purchase order PO-1 from Corner Cafe');
    expect(mail.text).toContain('Hello Sam,');
    expect(mail.text).toContain('Usual delivery door, please.');
    expect(mail.text).toMatch(/12 × Beans \(Bea-[^)]+\) @ \$8\.00 = \$96\.00/);

    await owner.patch(`/suppliers/${supplier.id}`, { email: '' }).expect(200);
    const second = (await draft([{ variantId: beans, quantity: 1, unitCostMinor: 1 }]).expect(201)).body;
    await owner.post(`/purchase-orders/${second.id}/order`, { email: true }).expect(409);
    expect((await owner.get(`/purchase-orders/${second.id}`).expect(200)).body.status).toBe('draft');

    const off = await shop(quiet);
    const third = (await off.draft([{ variantId: off.beans, quantity: 1, unitCostMinor: 1 }]).expect(201)).body;
    expect((await off.owner.post(`/purchase-orders/${third.id}/order`, { email: true }).expect(409)).body.code).toBe('email_off');
  });

  it('suggests items running low that aren’t already on order', async () => {
    const { owner, location, beans, mugs, draft } = await shop();
    await owner.post('/inventory/receipts', { locationId: location.id, lines: [{ variantId: beans, quantity: 3 }, { variantId: mugs, quantity: 20 }] }).expect(201);
    const names = async (n: number) => (await owner.get(`/purchase-orders/low-stock?locationId=${location.id}&atOrBelow=${n}`).expect(200)).body.map((x: { description: string }) => x.description);
    expect(await names(5)).toEqual(['Beans']);
    expect(await names(20)).toEqual(['Beans', 'Mug']);
    await draft([{ variantId: beans, quantity: 10, unitCostMinor: 800 }]).expect(201);
    expect(await names(20)).toEqual(['Mug']);
  });

  it('lets staff receive, but not order or manage suppliers', async () => {
    const { owner, beans, supplier, draft } = await shop();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const po = (await draft([{ variantId: beans, quantity: 2, unitCostMinor: 500 }]).expect(201)).body;
    await staff.post(`/purchase-orders/${po.id}/order`, {}).expect(403);
    await owner.post(`/purchase-orders/${po.id}/order`, {}).expect(200);
    await staff.get('/purchase-orders').expect(200);
    await staff.post(`/purchase-orders/${po.id}/receive`, { id: randomUUID(), lines: [{ lineId: po.lines[0].id, quantity: 2 }] }).expect(201);
    await staff.post('/suppliers', { name: 'Mine' }).expect(403);
    await staff.patch(`/suppliers/${supplier.id}`, { name: 'Renamed' }).expect(403);
    await staff.post('/purchase-orders', { supplierId: supplier.id, locationId: po.locationId, lines: [] }).expect(403);
  });

  it('keeps orders to their business and needs Inventory', async () => {
    const mine = await shop();
    const po = (await mine.draft([{ variantId: mine.beans, quantity: 1, unitCostMinor: 1 }]).expect(201)).body;
    const other = await shop();
    await other.owner.get(`/purchase-orders/${po.id}`).expect(404);
    await other.owner.post('/purchase-orders', { supplierId: mine.supplier.id, locationId: other.location.id, lines: [] }).expect(400);
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    await owner.put('/modules/purchasing', { enabled: true }).expect(409);
  });
});

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { Client, createTestApp, unique } from './helpers';

const outbox: { to: string[]; subject: string }[] = [];
const fakeResend = (async (_url: string, init: RequestInit) => {
  outbox.push(JSON.parse(String(init.body)));
  return new Response('{"id":"email_1"}', { status: 200 });
}) as unknown as typeof fetch;

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp({ env: { RESEND_API_KEY: 're_test' }, providers: [[MAIL_FETCH, fakeResend]] });
});

afterAll(async () => {
  await app.close();
});

async function shop(modules = ['catalog', 'pos', 'customers']) {
  const owner = await Client.signIn(app);
  await owner.createBusiness('Corner Cafe');
  for (const m of modules) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago', taxRateBps: 1000 }).expect(201)).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const sell = async (as: Client, customerId?: string | null, quantity = 1) => {
    const sale = (await as.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity }], customerId }).expect(201)).body;
    await as.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: sale.totalMinor }).expect(201);
    return sale;
  };
  return { owner, register, latte, sell };
}

describe('customers', () => {
  it('needs Point of sale and is turned on like any other tool', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    await owner.put('/modules/customers', { enabled: true }).expect(409);
    await owner.get('/customers').expect(403);
  });

  it('adds customers with tidy contact details and refuses duplicates', async () => {
    const { owner } = await shop();
    const ana = (await owner.post('/customers', { name: ' Ana Lopez ', email: ' Ana@Example.COM ', phone: '(312) 555-0100', note: 'Oat milk' }).expect(201)).body;
    expect(ana).toMatchObject({ name: 'Ana Lopez', email: 'ana@example.com', phone: '3125550100', note: 'Oat milk' });
    await owner.post('/customers', { name: 'No contact', email: '', phone: '' }).expect(201);
    await owner.post('/customers', { name: 'Bad', email: 'nope' }).expect(400);
    await owner.post('/customers', { name: 'Bad', phone: '12' }).expect(400);
    await owner.post('/customers', { name: '' }).expect(400);

    const dupe = await owner.post('/customers', { name: 'Ana again', email: 'ana@example.com' }).expect(409);
    expect(dupe.body).toMatchObject({ code: 'customer_exists', customer: { id: ana.id, name: 'Ana Lopez' } });
    expect(dupe.body.message).toContain('email');
    const dupePhone = await owner.post('/customers', { name: 'Ana phone', phone: '312.555.0100' }).expect(409);
    expect(dupePhone.body.message).toContain('phone');

    // Searching by name words, email or phone digits.
    await owner.post('/customers', { name: 'Ben Ortiz', phone: '+1 773 555 0199' }).expect(201);
    const names = async (search: string) => (await owner.get(`/customers?search=${encodeURIComponent(search)}`).expect(200)).body.map((c: { name: string }) => c.name);
    expect(await names('lopez ana')).toEqual(['Ana Lopez']);
    expect(await names('EXAMPLE.com')).toEqual(['Ana Lopez']);
    expect(await names('555-0199')).toEqual(['Ben Ortiz']);
    expect(await names('a%')).toEqual([]);
    expect(await names('')).toHaveLength(3);
  });

  it('tracks visits and spending, and emails receipts to the customer by default', async () => {
    const { owner, register, sell } = await shop();
    const ana = (await owner.post('/customers', { name: 'Ana', email: 'ana@example.com' }).expect(201)).body;
    const first = await sell(owner, ana.id, 2); // 1100
    await sell(owner, ana.id); // 550
    await sell(owner); // walk-in

    const sale = (await owner.get(`/sales/${first.id}`).expect(200)).body;
    expect(sale.customer).toEqual({ id: ana.id, name: 'Ana', email: 'ana@example.com', phone: null });
    const listed = (await owner.get('/sales').expect(200)).body.sales;
    expect(listed.filter((s: { customerName: string | null }) => s.customerName === 'Ana')).toHaveLength(2);

    await owner.post(`/sales/${first.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }], restock: false, registerSessionId: register.id }).expect(201);
    const detail = (await owner.get(`/customers/${ana.id}`).expect(200)).body;
    expect(detail).toMatchObject({ visits: 2, spentMinor: 1100, sales: [{ totalMinor: 550 }, { totalMinor: 1100, refundedMinor: 550 }] });
    expect(detail.lastVisitAt).toBeTruthy();

    await owner.post(`/sales/${first.id}/receipt/email`, {}).expect(200);
    expect(outbox.at(-1)!.to).toEqual(['ana@example.com']);
    const walkIn = await sell(owner);
    const res = await owner.post(`/sales/${walkIn.id}/receipt/email`, {}).expect(400);
    expect(res.body.message).toContain('Enter an email');
  });

  it('attaches and removes a customer on a sale', async () => {
    const { owner, sell } = await shop();
    const ana = (await owner.post('/customers', { name: 'Ana' }).expect(201)).body;
    const sale = await sell(owner);
    expect((await owner.post(`/sales/${sale.id}/customer`, { customerId: ana.id }).expect(200)).body.customer.name).toBe('Ana');
    expect((await owner.post(`/sales/${sale.id}/customer`, { customerId: null }).expect(200)).body.customer).toBeNull();
    await owner.post(`/sales/${sale.id}/customer`, { customerId: randomUUID() }).expect(400);
    const actions = (await owner.get('/audit').expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['customer.created', 'sale.customer_set', 'sale.customer_removed']));
  });

  it('keeps customers to their business and to the Customers tool', async () => {
    const { owner, register, latte } = await shop(['catalog', 'pos']);
    const other = await shop();
    const theirs = (await other.owner.post('/customers', { name: 'Theirs' }).expect(201)).body;
    // Turned off here: a sale can't take a customer.
    const res = await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 1 }], customerId: theirs.id }).expect(403);
    expect(res.body.message).toContain('turned off');
    await owner.put('/modules/customers', { enabled: true }).expect(200);
    // Another business's customer doesn't exist here.
    await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 1 }], customerId: theirs.id }).expect(400);
    await owner.get(`/customers/${theirs.id}`).expect(404);
    expect((await owner.get('/customers').expect(200)).body).toEqual([]);
  });

  it('lets staff add customers at checkout, but only managers edit or delete them', async () => {
    const { owner, sell } = await shop();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const ana = (await staff.post('/customers', { name: 'Ana', phone: '3125550100' }).expect(201)).body;
    const sale = await sell(owner, ana.id);
    await staff.get(`/customers/${ana.id}`).expect(200);
    await staff.patch(`/customers/${ana.id}`, { name: 'Ana L' }).expect(403);
    await staff.delete(`/customers/${ana.id}`).expect(403);

    const ben = (await owner.post('/customers', { name: 'Ben', email: 'ben@example.com' }).expect(201)).body;
    await owner.patch(`/customers/${ana.id}`, { email: 'BEN@example.com' }).expect(409);
    expect((await owner.patch(`/customers/${ana.id}`, { name: 'Ana Lopez', email: 'ana@example.com', phone: '' }).expect(200)).body).toMatchObject({
      name: 'Ana Lopez',
      email: 'ana@example.com',
      phone: null,
    });
    await owner.patch(`/customers/${ben.id}`, {}).expect(400);

    // Deleting removes the details; the sale stays, without a customer.
    await owner.delete(`/customers/${ana.id}`).expect(200);
    await owner.get(`/customers/${ana.id}`).expect(404);
    const after = (await owner.get(`/sales/${sale.id}`).expect(200)).body;
    expect(after).toMatchObject({ status: 'completed', customerId: null, customer: null });
    await owner.delete(`/customers/${ana.id}`).expect(404);
  });
});

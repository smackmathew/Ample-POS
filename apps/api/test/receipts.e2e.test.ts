import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { Client, createTestApp, unique } from './helpers';

const outbox: { to: string[]; subject: string; text: string; html?: string }[] = [];
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

async function paidSale(a: INestApplication) {
  const owner = await Client.signIn(a);
  await owner.createBusiness('Corner Cafe');
  for (const m of ['catalog', 'pos']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (
    await owner
      .post('/locations', {
        name: 'Main St',
        timezone: 'America/Chicago',
        taxRateBps: 1000,
        address: { line1: '100 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' },
      })
      .expect(201)
  ).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 450, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const sale = (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 2 }] }).expect(201)).body;
  return { owner, register, latte, sale };
}

describe('receipts', () => {
  it('builds the receipt with the business’s settings, lines before tax and change', async () => {
    const { owner, sale } = await paidSale(app);
    await owner.patch('/tenant/receipt-settings', { footer: 'Thanks for visiting!', phone: '(312) 555-0100', website: '' }).expect(200);
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 2000 }).expect(201);

    const receipt = (await owner.get(`/sales/${sale.id}/receipt`).expect(200)).body;
    expect(receipt).toMatchObject({
      business: { name: 'Corner Cafe', phone: '(312) 555-0100', website: null, footer: 'Thanks for visiting!' },
      location: { name: 'Main St', timezone: 'America/Chicago', address: { city: 'Chicago' } },
      receiptNumber: 1,
      status: 'completed',
      lines: [{ description: 'Latte', quantity: 2, unitPriceMinor: 450, totalMinor: 900 }],
      subtotalMinor: 900,
      taxMinor: 90,
      totalMinor: 990,
      payments: [{ method: 'cash', tenderedMinor: 2000, changeMinor: 1010 }],
    });
  });

  it('emails a completed sale’s receipt, without keeping the address', async () => {
    const { owner, sale } = await paidSale(app);
    await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'customer@example.com' }).expect(409);
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 990 }).expect(201);
    await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'not an email' }).expect(400);
    await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'customer@example.com' }).expect(200);

    const mail = outbox.at(-1)!;
    expect(mail.to).toEqual(['customer@example.com']);
    expect(mail.subject).toBe('Your receipt from Corner Cafe (#1)');
    expect(mail.text).toContain('2 × Latte');
    expect(mail.html).toContain('Receipt #1');

    const audit = (await owner.get('/audit').expect(200)).body.entries.find((e: { action: string }) => e.action === 'sale.receipt_emailed');
    expect(audit.data).toEqual({ to: 'c…@example.com' });

    for (let i = 0; i < 4; i++) await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'customer@example.com' }).expect(200);
    await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'customer@example.com' }).expect(429);
  });

  it('only lets people who can sell see receipts, and owners change the settings', async () => {
    const { owner, sale } = await paidSale(app);
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get(`/sales/${sale.id}/receipt`).expect(200);
    await staff.patch('/tenant/receipt-settings', { footer: 'Hi' }).expect(403);
    const outsider = await Client.signIn(app);
    await outsider.createBusiness();
    await outsider.get(`/sales/${sale.id}/receipt`).expect(403); // Point of sale is off there
    for (const m of ['catalog', 'pos']) await outsider.put(`/modules/${m}`, { enabled: true }).expect(200);
    // Another business's sale doesn't exist as far as this one can tell.
    await outsider.get(`/sales/${sale.id}/receipt`).expect(404);
  });

  it('says so when email isn’t set up', async () => {
    const { owner, sale } = await paidSale(quiet);
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 990 }).expect(201);
    const res = await owner.post(`/sales/${sale.id}/receipt/email`, { email: 'customer@example.com' }).expect(409);
    expect(res.body.code).toBe('email_off');
  });
});

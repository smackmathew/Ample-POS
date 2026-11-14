import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, unique } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

type Line = { variantId: string; quantity: number } | { giftCard: { code?: string; amountMinor: number } };

/** A cafe with $5.00 lattes, 10% tax, an open register, and gift cards on. */
async function cafe(modules = ['catalog', 'pos', 'gift-cards']) {
  const owner = await Client.signIn(app);
  await owner.createBusiness('Corner Cafe');
  for (const m of modules) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago', taxRateBps: 1000 }).expect(201)).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const lattes = (quantity: number): Line => ({ variantId: latte.id, quantity });
  const ring = async (lines: Line[], as: Client = owner) => (await as.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines }).expect(201)).body;
  const cash = async (sale: { id: string; dueMinor: number }) =>
    (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: sale.dueMinor }).expect(201)).body.sale;
  const giftPay = (saleId: string, code: string, amountMinor?: number) => owner.post(`/sales/${saleId}/payments`, { id: randomUUID(), method: 'gift_card', code, amountMinor });
  const balance = async (code: string) => (await owner.get(`/gift-cards/balance?code=${encodeURIComponent(code)}`).expect(200)).body.balanceMinor as number;
  /** Sells a card for `amountMinor` (paid in cash) and returns its code. */
  const sellCard = async (amountMinor: number, code?: string) => {
    const sale = await cash(await ring([{ giftCard: { code, amountMinor } }]));
    return sale.lines[0].giftCardCode as string;
  };
  return { owner, register, latte, lattes, ring, cash, giftPay, balance, sellCard };
}

describe('gift cards', () => {
  it('sells a card tax-free alongside items, and loads it once the sale is paid', async () => {
    const { owner, lattes, ring, cash, balance } = await cafe();
    const sale = await ring([lattes(1), { giftCard: { amountMinor: 2500 } }]);
    expect(sale).toMatchObject({ subtotalMinor: 3000, taxMinor: 50, totalMinor: 3050 });
    const card = sale.lines[1];
    expect(card).toMatchObject({ kind: 'gift_card', variantId: null, taxMinor: 0, totalMinor: 2500 });
    expect(card.giftCardCode).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    expect(card.description).toBe(`Gift card ${card.giftCardCode.match(/.{4}/g).join('-')}`);
    await owner.get(`/gift-cards/balance?code=${card.giftCardCode}`).expect(404); // not paid for yet
    await cash(sale);
    // Codes can be typed in any case, with dashes or spaces.
    expect(await balance(card.description.slice(10).toLowerCase())).toBe(2500);
    const receipt = (await owner.get(`/sales/${sale.id}/receipt`).expect(200)).body;
    expect(receipt.lines[1]).toMatchObject({ description: 'Gift card', detail: `Code ${card.description.slice(10)}`, totalMinor: 2500 });
  });

  it('pays with a card, in full or in part, and shows what is left', async () => {
    const { owner, lattes, ring, cash, giftPay, balance, sellCard } = await cafe();
    const code = await sellCard(2000);
    const small = await ring([lattes(1)]); // $5.50
    const paid = (await giftPay(small.id, code).expect(201)).body;
    expect(paid.payment).toMatchObject({ method: 'gift_card', amountMinor: 550 });
    expect(paid.sale).toMatchObject({ status: 'completed', payments: [{ giftCard: { last4: code.slice(-4), balanceMinor: 1450 } }] });

    const big = await ring([lattes(4)]); // $22.00: the card covers $14.50
    const part = (await giftPay(big.id, code).expect(201)).body.sale;
    expect(part).toMatchObject({ status: 'open', paidMinor: 1450, dueMinor: 750 });
    await giftPay(big.id, code).expect(409); // nothing left
    expect((await cash(part)).status).toBe('completed');
    expect(await balance(code)).toBe(0);
    const receipt = (await owner.get(`/sales/${big.id}/receipt`).expect(200)).body;
    expect(receipt.payments[0]).toMatchObject({ method: 'gift_card', amountMinor: 1450, giftCard: { last4: code.slice(-4), balanceMinor: 0 } });

    await giftPay((await ring([lattes(1)])).id, 'NOSUCHCARD').expect(404);
  });

  it('reloads a card, and a card can’t pay for its own reload', async () => {
    const { owner, register, lattes, ring, cash, giftPay, balance, sellCard } = await cafe();
    // A physical card's printed code can be used when selling it.
    const code = await sellCard(1000, 'abcd 2345 efgh');
    expect(code).toBe('ABCD2345EFGH');
    const reload = await ring([{ giftCard: { code: 'ABCD-2345-EFGH', amountMinor: 1500 } }]);
    expect(reload.lines[0].description).toBe('Gift card reload ••••EFGH');
    await giftPay(reload.id, code).expect(409);
    await cash(reload);
    expect(await balance(code)).toBe(2500);
    await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [lattes(1), { giftCard: { code, amountMinor: 500 } }, { giftCard: { code, amountMinor: 500 } }] }).expect(400);
  });

  it('puts money back on the card for refunds, voids and canceled payments', async () => {
    const { owner, register, lattes, ring, giftPay, balance, sellCard } = await cafe();
    const code = await sellCard(5000);

    const sale = (await giftPay((await ring([lattes(2)])).id, code).expect(201)).body.sale; // $11.00
    expect(await balance(code)).toBe(3900);
    await owner
      .post(`/sales/${sale.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }], restock: false, registerSessionId: register.id })
      .expect(201);
    expect(await balance(code)).toBe(4450);

    const open = await ring([lattes(10)]); // $55.00, more than the card holds
    const partial = (await giftPay(open.id, code).expect(201)).body;
    expect(await balance(code)).toBe(0);
    await owner.post(`/sales/${open.id}/payments/${partial.payment.id}/cancel`).expect(201);
    expect(await balance(code)).toBe(4450);
    await giftPay(open.id, code, 1000).expect(201);
    expect(await balance(code)).toBe(3450);
    await owner.post(`/sales/${open.id}/void`).expect(201);
    expect(await balance(code)).toBe(4450);
  });

  it('refunds a gift card purchase only while its money is still on the card', async () => {
    const { owner, register, lattes, ring, cash, giftPay, balance } = await cafe();
    const sale = await cash(await ring([{ giftCard: { amountMinor: 2000 } }]));
    const code = sale.lines[0].giftCardCode;
    await giftPay((await ring([lattes(1)])).id, code).expect(201);
    const refund = { lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }], restock: false, registerSessionId: register.id };
    const blocked = await owner.post(`/sales/${sale.id}/refunds`, { id: randomUUID(), ...refund }).expect(409);
    expect(blocked.body.message).toContain('14.50 is left');

    const unused = await cash(await ring([{ giftCard: { amountMinor: 2000 } }]));
    await owner.post(`/sales/${unused.id}/refunds`, { id: randomUUID(), ...refund, lines: [{ saleLineId: unused.lines[0].id, quantity: 1 }] }).expect(201);
    expect(await balance(unused.lines[0].giftCardCode)).toBe(0);
  });

  it('lets managers issue, adjust and void cards; staff only check balances', async () => {
    const { owner, lattes, ring, giftPay, sellCard } = await cafe();
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const code = await sellCard(1000);
    await staff.get(`/gift-cards/balance?code=${code}`).expect(200);
    await staff.get('/gift-cards').expect(403);

    const issued = (await owner.post('/gift-cards', { amountMinor: 2500, note: 'School raffle' }).expect(201)).body;
    expect(issued).toMatchObject({ balanceMinor: 2500, status: 'active', entries: [{ kind: 'adjust', note: 'School raffle' }] });
    await owner.post('/gift-cards', { amountMinor: 2500, note: '' }).expect(400);
    await owner.post(`/gift-cards/${issued.id}/adjust`, { amountMinor: -3000, note: 'Too much' }).expect(400);
    expect((await owner.post(`/gift-cards/${issued.id}/adjust`, { amountMinor: -500, note: 'Correction' }).expect(201)).body.balanceMinor).toBe(2000);
    await staff.post(`/gift-cards/${issued.id}/adjust`, { amountMinor: 500, note: 'x' }).expect(403);

    const list = (await owner.get(`/gift-cards?search=${code.slice(-6)}`).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ code: code.match(/.{4}/g)!.join('-'), balanceMinor: 1000 })]);

    const voided = (await owner.post(`/gift-cards/${list[0].id}/void`, { note: 'Reported stolen' }).expect(201)).body;
    expect(voided).toMatchObject({ status: 'void', balanceMinor: 0 });
    await giftPay((await ring([lattes(1)])).id, code).expect(409);
    await owner.post('/sales', { id: randomUUID(), registerSessionId: (await owner.get('/registers/sessions/current').expect(200)).body.session.id, lines: [{ giftCard: { code, amountMinor: 1000 } }] }).expect(409);
  });

  it('keeps cards to their business and needs the tool turned on', async () => {
    const mine = await cafe();
    const code = await mine.sellCard(1000);
    const other = await cafe(['catalog', 'pos']);
    const sale = await other.ring([other.lattes(1)]);
    await other.giftPay(sale.id, code).expect(403);
    await other.owner.post('/sales', { id: randomUUID(), registerSessionId: other.register.id, lines: [{ giftCard: { amountMinor: 1000 } }] }).expect(403);
    await other.owner.put('/modules/gift-cards', { enabled: true }).expect(200);
    await other.giftPay(sale.id, code).expect(404); // another business's card doesn't exist here
  });

  it('keeps gift cards out of points, product sales and the drawer', async () => {
    const { owner, register, lattes, ring, cash, giftPay, sellCard } = await cafe(['catalog', 'pos', 'gift-cards', 'customers', 'loyalty', 'reporting']);
    const ana = (await owner.post('/customers', { name: 'Ana' }).expect(201)).body.id;
    const bought = await cash((await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, customerId: ana, lines: [{ giftCard: { amountMinor: 5000 } }] }).expect(201)).body);
    expect(bought.loyalty).toMatchObject({ earnedPoints: 0 });
    const spent = (await giftPay((await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, customerId: ana, lines: [lattes(2)] }).expect(201)).body.id, bought.lines[0].giftCardCode).expect(201)).body.sale;
    expect(spent.loyalty).toMatchObject({ earnedPoints: 10 });
    await sellCard(1000);
    await ring([lattes(1)]);

    const summary = (await owner.get(`/registers/sessions/${register.id}`).expect(200)).body;
    expect(summary.totals).toMatchObject({ giftCardMinor: 1100, cashMinor: 6000, expectedCashMinor: 6000 });
    const today = new Date().toISOString().slice(0, 10);
    const report = (await owner.get(`/reports/sales?from=${addDays(today, -1)}&to=${addDays(today, 1)}`).expect(200)).body;
    expect(report.topProducts.map((p: { description: string }) => p.description)).toEqual(['Latte']);
    expect(report.tenders).toMatchObject({ cash: 6000, gift_card: 1100 });
  });
});

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

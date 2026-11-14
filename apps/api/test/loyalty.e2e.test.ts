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

/** A cafe with lattes at $5.00 and 10% tax, an open register, and loyalty on. */
async function cafe(modules = ['catalog', 'pos', 'customers', 'loyalty']) {
  const owner = await Client.signIn(app);
  await owner.createBusiness('Corner Cafe');
  for (const m of modules) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago', taxRateBps: 1000 }).expect(201)).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const muffin = (await owner.post('/catalog/products', { name: 'Muffin', variants: [{ priceMinor: 300, sku: unique('M'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const ring = async (customerId: string | null, lines = [{ variantId: latte.id, quantity: 2 }]) =>
    (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines, customerId }).expect(201)).body;
  const pay = async (sale: { id: string; dueMinor: number }) =>
    (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: sale.dueMinor }).expect(201)).body.sale;
  const customer = async (name: string) => (await owner.post('/customers', { name }).expect(201)).body.id as string;
  const points = async (id: string) => (await owner.get(`/loyalty/customers/${id}`).expect(200)).body;
  return { owner, register, latte, muffin, ring, pay, customer, points };
}

describe('loyalty rewards', () => {
  it('needs Customers, and starts with 1 point per dollar and 100 points for $5 off', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    for (const m of ['catalog', 'pos']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
    await owner.put('/modules/loyalty', { enabled: true }).expect(409);
    await owner.put('/modules/customers', { enabled: true }).expect(200);
    await owner.put('/modules/loyalty', { enabled: true }).expect(200);
    expect((await owner.get('/loyalty/program').expect(200)).body).toEqual({ pointsPerDollar: 1, rewardPoints: 100, rewardValueMinor: 500 });
    await owner.put('/loyalty/program', { pointsPerDollar: 0, rewardPoints: 100, rewardValueMinor: 500 }).expect(400);
    expect((await owner.put('/loyalty/program', { pointsPerDollar: 2, rewardPoints: 50, rewardValueMinor: 300 }).expect(200)).body).toEqual({
      pointsPerDollar: 2,
      rewardPoints: 50,
      rewardValueMinor: 300,
    });
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get('/loyalty/program').expect(200);
    await staff.put('/loyalty/program', { pointsPerDollar: 9, rewardPoints: 1, rewardValueMinor: 1 }).expect(403);
  });

  it('earns on what was spent before tax, and gives back what is refunded', async () => {
    const { owner, register, ring, pay, customer, points } = await cafe();
    const ana = await customer('Ana');
    const sale = await pay(await ring(ana)); // $10.00 before tax, $11.00 total
    expect(sale.loyalty).toMatchObject({ earnedPoints: 10, balance: 10 });
    await pay(await ring(null)); // walk-in: no one earns

    const refund = { id: randomUUID(), lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }], restock: false, registerSessionId: register.id };
    const after = (await owner.post(`/sales/${sale.id}/refunds`, refund).expect(201)).body;
    expect(after.loyalty).toMatchObject({ earnedPoints: 5, balance: 5 });
    await owner.post(`/sales/${sale.id}/refunds`, refund).expect(201); // retried: no change
    const history = await points(ana);
    expect(history.balance).toBe(5);
    expect(history.entries.map((e: { kind: string; points: number }) => [e.kind, e.points])).toEqual([
      ['earn', -5],
      ['earn', 10],
    ]);
  });

  it('moves a paid sale’s points when its customer is changed later', async () => {
    const { owner, ring, pay, customer, points } = await cafe();
    const [ana, ben] = [await customer('Ana'), await customer('Ben')];
    const sale = await pay(await ring(null));
    await owner.post(`/sales/${sale.id}/customer`, { customerId: ana }).expect(200);
    expect((await points(ana)).balance).toBe(10);
    await owner.post(`/sales/${sale.id}/customer`, { customerId: ben }).expect(200);
    expect([(await points(ana)).balance, (await points(ben)).balance]).toEqual([0, 10]);
    await owner.post(`/sales/${sale.id}/customer`, { customerId: null }).expect(200);
    expect((await points(ben)).balance).toBe(0);
  });

  it('takes a reward off as a discount, taxed after, and earns on the rest', async () => {
    const { owner, latte, muffin, ring, pay, customer, points } = await cafe();
    await owner.put('/loyalty/program', { pointsPerDollar: 1, rewardPoints: 10, rewardValueMinor: 300 }).expect(200);
    const ana = await customer('Ana');
    await owner.post(`/loyalty/customers/${ana}/adjust`, { points: 25, note: 'Welcome bonus' }).expect(201);

    // $10.00 of lattes and $3.00 muffin; 2 rewards = $6.00 off, split 10:3.
    const sale = await ring(ana, [{ variantId: latte.id, quantity: 2 }, { variantId: muffin.id, quantity: 1 }]);
    expect(sale.loyalty).toMatchObject({ balance: 25, rewardsAvailable: 2, rewardPoints: 10, rewardValueMinor: 300 });
    await owner.post(`/sales/${sale.id}/reward`, { rewards: 3 }).expect(409); // only 25 points
    const rewarded = (await owner.post(`/sales/${sale.id}/reward`, { rewards: 2 }).expect(200)).body;
    expect(rewarded).toMatchObject({ rewardMinor: 600, rewardPoints: 20, discountMinor: 600, taxMinor: 70, totalMinor: 770 });
    expect(rewarded.lines.map((l: { rewardMinor: number }) => l.rewardMinor)).toEqual([462, 138]);
    expect(rewarded.loyalty.balance).toBe(5);
    await owner.post(`/sales/${sale.id}/reward`, { rewards: 1 }).expect(409); // already has one

    const paid = await pay(rewarded);
    expect(paid.loyalty).toMatchObject({ earnedPoints: 7, balance: 12 });
    await owner.delete(`/sales/${sale.id}/reward`).expect(409); // paid: the reward stays
    await owner.post(`/sales/${sale.id}/customer`, { customerId: null }).expect(409);

    const receipt = (await owner.get(`/sales/${sale.id}/receipt`).expect(200)).body;
    expect(receipt).toMatchObject({ rewardMinor: 600, loyalty: { earned: 7, balance: 12 } });
    expect(receipt.lines.map((l: { discountMinor: number; totalMinor: number }) => [l.discountMinor, l.totalMinor])).toEqual([
      [0, 1000],
      [0, 300],
    ]);
    expect((await points(ana)).entries.map((e: { kind: string; points: number }) => [e.kind, e.points])).toEqual([
      ['earn', 7],
      ['redeem', -20],
      ['adjust', 25],
    ]);
  });

  it('gives the points back when the reward is taken off or the sale is voided', async () => {
    const { owner, ring, pay, customer, points } = await cafe();
    await owner.put('/loyalty/program', { pointsPerDollar: 1, rewardPoints: 10, rewardValueMinor: 500 }).expect(200);
    const ana = await customer('Ana');
    await owner.post(`/loyalty/customers/${ana}/adjust`, { points: 30, note: 'Moved from paper cards' }).expect(201);

    const first = await ring(ana);
    await owner.post(`/sales/${first.id}/reward`, {}).expect(200);
    await owner.post(`/sales/${first.id}/customer`, { customerId: null }).expect(409);
    const restored = (await owner.delete(`/sales/${first.id}/reward`).expect(200)).body;
    expect(restored).toMatchObject({ rewardMinor: 0, rewardPoints: 0, discountMinor: 0, totalMinor: 1100, loyalty: { balance: 30 } });
    expect(restored.lines[0]).toMatchObject({ discountMinor: 0, rewardMinor: 0 });

    const second = await ring(ana);
    await owner.post(`/sales/${second.id}/reward`, {}).expect(200);
    expect((await points(ana)).balance).toBe(20);
    await owner.post(`/sales/${second.id}/void`).expect(201);
    expect((await points(ana)).balance).toBe(30);

    // A reward can't be worth more than the sale; one that covers it all completes it.
    await owner.put('/loyalty/program', { pointsPerDollar: 1, rewardPoints: 10, rewardValueMinor: 1000 }).expect(200);
    const third = await ring(ana, [{ variantId: (first.lines[0] as { variantId: string }).variantId, quantity: 1 }]);
    await owner.post(`/sales/${third.id}/reward`, {}).expect(400);
    const free = await ring(ana);
    const done = (await owner.post(`/sales/${free.id}/reward`, {}).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', totalMinor: 0, loyalty: { earnedPoints: 0, balance: 20 } });

    // After a payment, rewards can't be added.
    const paid = await pay(await ring(ana));
    await owner.post(`/sales/${paid.id}/reward`, {}).expect(409);
  });

  it('keeps adjustments to managers, with a reason', async () => {
    const { owner, customer, points } = await cafe();
    const ana = await customer('Ana');
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get(`/loyalty/customers/${ana}`).expect(200);
    await staff.post(`/loyalty/customers/${ana}/adjust`, { points: 100, note: 'Friend' }).expect(403);
    await owner.post(`/loyalty/customers/${ana}/adjust`, { points: 0, note: 'x' }).expect(400);
    await owner.post(`/loyalty/customers/${ana}/adjust`, { points: 5, note: '' }).expect(400);
    await owner.post(`/loyalty/customers/${ana}/adjust`, { points: -5, note: 'Correction' }).expect(201);
    expect((await points(ana)).balance).toBe(-5);
    await owner.get(`/loyalty/customers/${randomUUID()}`).expect(404);
    const audit = (await owner.get('/audit').expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toContain('loyalty.points_adjusted');
  });

  it('does nothing while the tool is off', async () => {
    const { owner, ring, pay, customer } = await cafe(['catalog', 'pos', 'customers']);
    const ana = await customer('Ana');
    const sale = await ring(ana);
    expect(sale.loyalty).toBeNull();
    await owner.post(`/sales/${sale.id}/reward`, {}).expect(403);
    await pay(sale);
    await owner.get(`/loyalty/customers/${ana}`).expect(403);
    await owner.put('/modules/loyalty', { enabled: true }).expect(200);
    // Sales from before the program don't earn retroactively.
    expect((await owner.get(`/loyalty/customers/${ana}`).expect(200)).body.balance).toBe(0);
  });
});

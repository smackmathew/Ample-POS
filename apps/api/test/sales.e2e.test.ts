import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_PROVIDER } from '../src/payments/provider';
import { StripeCardProvider } from '../src/payments/stripe.provider';
import { adminSql, Client, createTestApp, unique } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

/** A business with a store taxed at 8.25%, a $10.00 mug (10 in stock) and the owner's register open with a $100 float. */
async function store(a: INestApplication = app) {
  const owner = await Client.signIn(a);
  await owner.createBusiness();
  for (const m of ['catalog', 'inventory', 'pos']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'UTC', taxRateBps: 825 }).expect(201)).body;
  const mug = (await owner.post('/catalog/products', { name: 'Mug', variants: [{ priceMinor: 1000, sku: unique('MUG') }] }).expect(201)).body.variants[0];
  const wrap = (await owner.post('/catalog/products', { name: 'Gift wrap', variants: [{ priceMinor: 300, trackInventory: false }] }).expect(201)).body.variants[0];
  await owner.post('/inventory/receipts', { locationId: location.id, lines: [{ variantId: mug.id, quantity: 10 }] }).expect(201);
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 10_000 }).expect(201)).body;
  const sell = (client: Client, lines: { variantId: string; quantity: number; discountMinor?: number }[], registerSessionId = register.id) =>
    client.post('/sales', { id: randomUUID(), registerSessionId, lines });
  const stock = async () =>
    (await owner.get(`/inventory/levels?locationId=${location.id}`).expect(200)).body.levels.find((l: { variantId: string }) => l.variantId === mug.id).onHand;
  return { owner, location, mug, wrap, register, sell, stock };
}

describe('checkout', () => {
  it('rings up a cash sale with tax and change, then adjusts stock', async () => {
    const { owner, mug, sell, stock } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 2 }]).expect(201)).body;
    // $20.00 + 8.25% = $21.65
    expect(sale).toMatchObject({ status: 'open', subtotalMinor: 2000, taxMinor: 165, totalMinor: 2165, dueMinor: 2165 });
    expect(sale.lines[0]).toMatchObject({ description: 'Mug', quantity: 2, unitPriceMinor: 1000, totalMinor: 2165 });

    const paymentId = randomUUID();
    const paid = (await owner.post(`/sales/${sale.id}/payments`, { id: paymentId, method: 'cash', tenderedMinor: 3000 }).expect(201)).body;
    expect(paid.payment).toMatchObject({ amountMinor: 2165, tenderedMinor: 3000, changeMinor: 835, status: 'succeeded' });
    expect(paid.sale).toMatchObject({ status: 'completed', receiptNumber: 1, paidMinor: 2165, dueMinor: 0 });
    expect(await stock()).toBe(8);

    // Retrying either request changes nothing.
    await owner.post('/sales', { id: sale.id, registerSessionId: sale.registerSessionId, lines: [{ variantId: mug.id, quantity: 2 }] }).expect(201);
    const retry = (await owner.post(`/sales/${sale.id}/payments`, { id: paymentId, method: 'cash', tenderedMinor: 3000 }).expect(201)).body;
    expect(retry.sale.paidMinor).toBe(2165);
    expect(await stock()).toBe(8);

    const second = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    const done = (await owner.post(`/sales/${second.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 5000 }).expect(201)).body;
    expect(done.sale.receiptNumber).toBe(2);
  });

  it('takes card payments through the reader, including a decline and a split tender', async () => {
    const { owner, mug, sell } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 3 }]).expect(201)).body; // $32.48
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 1000 }).expect(201);

    const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    expect(card.payment).toMatchObject({ method: 'card', status: 'pending', amountMinor: 2248, provider: 'simulated' });
    expect(card.clientSecret).toBeTruthy();
    // While the card is pending nothing else can be charged.
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 100 }).expect(409);

    const declined = (await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'decline' }).expect(201)).body;
    expect(declined.status).toBe('open');
    expect(declined.payments[1]).toMatchObject({ status: 'pending', lastError: 'Your card was declined.' });

    const approved = (await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201)).body;
    expect(approved).toMatchObject({ status: 'completed', paidMinor: 3248, dueMinor: 0 });
  });

  it('rejects overcharging and frees the amount when a card payment is canceled', async () => {
    const { owner, mug, sell } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body; // $10.83
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card', amountMinor: 1084 }).expect(400);
    const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    const canceled = (await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/cancel`).expect(201)).body;
    expect(canceled.payments[0].status).toBe('canceled');
    expect(canceled.dueMinor).toBe(1083);
    const cash = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 2000 }).expect(201)).body;
    expect(cash.sale.status).toBe('completed');
  });

  it('refuses to cancel a card payment that already went through', async () => {
    const { owner, mug, sell } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201);
    await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/cancel`).expect(201);
    expect((await owner.get(`/sales/${sale.id}`).expect(200)).body.status).toBe('completed');
  });

  it('voids unpaid sales but not ones with money taken', async () => {
    const { owner, mug, sell, stock } = await store();
    const pending = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    const card = (await owner.post(`/sales/${pending.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    const voided = (await owner.post(`/sales/${pending.id}/void`).expect(201)).body;
    expect(voided.status).toBe('voided');
    expect(voided.payments[0].status).toBe('canceled');
    await owner.post(`/sales/${pending.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201);
    expect((await owner.get(`/sales/${pending.id}`)).body.status).toBe('voided');

    const partial = (await sell(owner, [{ variantId: mug.id, quantity: 2 }]).expect(201)).body;
    await owner.post(`/sales/${partial.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 500 }).expect(201);
    await owner.post(`/sales/${partial.id}/void`).expect(409);
    expect(await stock()).toBe(10);
  });

  it('completes a fully discounted sale immediately and enforces the discount permission', async () => {
    const { owner, mug, wrap, sell, register } = await store();
    const free = (await sell(owner, [{ variantId: wrap.id, quantity: 1, discountMinor: 300 }]).expect(201)).body;
    expect(free).toMatchObject({ status: 'completed', totalMinor: 0 });
    await sell(owner, [{ variantId: mug.id, quantity: 1, discountMinor: 1001 }]).expect(400);

    const staff = await owner.invite(await Client.signIn(app), 'staff');
    // Staff can't ring up on the owner's web register, or give discounts on their own.
    await sell(staff, [{ variantId: mug.id, quantity: 1 }], register.id).expect(403);
    const own = (await staff.post('/registers/sessions', { locationId: register.locationId, openingFloatMinor: 0 }).expect(201)).body;
    await sell(staff, [{ variantId: mug.id, quantity: 1, discountMinor: 100 }], own.id).expect(403);
    await sell(staff, [{ variantId: mug.id, quantity: 1 }], own.id).expect(201);
  });

  it('does not sell archived products', async () => {
    const { owner, mug, sell } = await store();
    const product = (await owner.get(`/catalog/products?search=Mug`).expect(200)).body.products[0];
    await owner.patch(`/catalog/products/${product.id}`, { version: product.version, status: 'archived' }).expect(200);
    await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(400);
  });
});

describe('refunds', () => {
  it('refunds part of a sale to the original cash payment and restocks', async () => {
    const { owner, mug, sell, stock, register } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 2 }]).expect(201)).body; // $21.65
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 2165 }).expect(201);
    const lineId = sale.lines[0].id;

    // Paying cash back needs a drawer to take it from.
    const noDrawer = await owner.post(`/sales/${sale.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: lineId, quantity: 1 }], restock: true }).expect(400);
    expect(noDrawer.body.code).toBe('register_required');

    const first = (await owner
      .post(`/sales/${sale.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: lineId, quantity: 1 }], restock: true, registerSessionId: register.id })
      .expect(201)).body;
    expect(first.refunds[0]).toMatchObject({ amountMinor: 1082, restock: true });
    expect(await stock()).toBe(9);

    const refundId = randomUUID();
    const body = { id: refundId, lines: [{ saleLineId: lineId, quantity: 1 }], restock: false, registerSessionId: register.id };
    const second = (await owner.post(`/sales/${sale.id}/refunds`, body).expect(201)).body;
    // The last unit takes the remaining cent: 1082 + 1083 = 2165.
    expect(second.refundedMinor).toBe(2165);
    await owner.post(`/sales/${sale.id}/refunds`, body).expect(201); // retry is a no-op
    expect((await owner.get(`/sales/${sale.id}`)).body.refundedMinor).toBe(2165);
    const listed = (await owner.get(`/sales?receipt=${sale.receiptNumber ?? 1}`).expect(200)).body.sales;
    expect(listed).toEqual([expect.objectContaining({ id: sale.id, refundedMinor: 2165 })]);
    expect(await stock()).toBe(9);

    await owner
      .post(`/sales/${sale.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: lineId, quantity: 1 }], restock: false, registerSessionId: register.id })
      .expect(400);
  });

  it('refunds card payments through the processor without a drawer', async () => {
    const { owner, mug, sell } = await store();
    const sale = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201);
    const refunded = (await owner.post(`/sales/${sale.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: sale.lines[0].id, quantity: 1 }], restock: true }).expect(201)).body;
    expect(refunded.refunds[0].payments).toEqual([expect.objectContaining({ paymentId: card.payment.id, amountMinor: 1083, status: 'succeeded' })]);
  });

  it('requires the refund permission and a completed sale', async () => {
    const { owner, mug, sell } = await store();
    const open = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    await owner.post(`/sales/${open.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: open.lines[0].id, quantity: 1 }], restock: false }).expect(409);
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.post(`/sales/${open.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: open.lines[0].id, quantity: 1 }], restock: false }).expect(403);
  });
});

describe('registers', () => {
  it('reconciles the drawer on close: float + cash sales − cash refunds', async () => {
    const { owner, mug, sell, register } = await store();
    const a = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body; // 1083 cash
    await owner.post(`/sales/${a.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: 2000 }).expect(201);
    const b = (await sell(owner, [{ variantId: mug.id, quantity: 2 }]).expect(201)).body; // 2165 card
    const card = (await owner.post(`/sales/${b.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    await owner.post(`/sales/${b.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201);
    await owner
      .post(`/sales/${a.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: a.lines[0].id, quantity: 1 }], restock: true, registerSessionId: register.id })
      .expect(201);

    // A sale still waiting on a card blocks closing; an untouched cart does not.
    const stuck = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
    const pendingCard = (await owner.post(`/sales/${stuck.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    await owner.post(`/registers/sessions/${register.id}/close`, { countedCashMinor: 0 }).expect(409);
    await owner.post(`/sales/${stuck.id}/payments/${pendingCard.payment.id}/cancel`).expect(201);
    await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201);

    const summary = (await owner.get(`/registers/sessions/${register.id}`).expect(200)).body;
    expect(summary.totals).toMatchObject({ salesCount: 2, grossMinor: 3248, cashMinor: 1083, cardMinor: 2165, cashRefundsMinor: 1083, expectedCashMinor: 10_000 });

    const closed = (await owner.post(`/registers/sessions/${register.id}/close`, { countedCashMinor: 9_950 }).expect(201)).body;
    expect(closed).toMatchObject({ status: 'closed', expectedCashMinor: 10_000, countedCashMinor: 9_950, varianceMinor: -50 });
    await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(409);
    expect((await owner.get(`/sales?registerSessionId=${register.id}&status=voided`).expect(200)).body.sales).toHaveLength(2);
  });

  it('binds device registers to their device', async () => {
    const { owner, location, mug, register } = await store();
    await owner.post(`/registers/sessions/${register.id}/close`, { countedCashMinor: 10_000 }).expect(201);
    const reg = (await owner.post('/devices', { locationId: location.id, name: 'Till 1', kind: 'register' }).expect(201)).body;
    const cashier = await owner.invite(await Client.signIn(app), 'staff');
    cashier.deviceCredential = reg.credential;
    const till = (await cashier.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 5000 }).expect(201)).body;
    await cashier.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 5000 }).expect(409);
    expect((await cashier.get('/registers/sessions/current').expect(200)).body.session.id).toBe(till.id);

    // Another person can use the same till; nobody can use it from elsewhere.
    const other = await owner.invite(await Client.signIn(app), 'staff');
    other.deviceCredential = reg.credential;
    await other.post('/sales', { id: randomUUID(), registerSessionId: till.id, lines: [{ variantId: mug.id, quantity: 1 }] }).expect(201);
    await owner.post('/sales', { id: randomUUID(), registerSessionId: till.id, lines: [{ variantId: mug.id, quantity: 1 }] }).expect(403);
    // Managers can close any register.
    await owner.post(`/registers/sessions/${till.id}/close`, { countedCashMinor: 5000 }).expect(201);
  });
});

describe('Stripe webhooks', () => {
  /** A minimal in-memory Stripe: PaymentIntents and refunds, honoring Idempotency-Key. */
  function fakeStripe() {
    const intents = new Map<string, { id: string; amount: number; status: string; client_secret: string }>();
    const byKey = new Map<string, string>();
    const impl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const params = new URLSearchParams(String(init.body ?? ''));
      const key = (init.headers as Record<string, string>)['Idempotency-Key'];
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === '/v1/payment_intents' && init.method === 'POST') {
        const id = byKey.get(key!) ?? `pi_${randomUUID().slice(0, 8)}`;
        byKey.set(key!, id);
        if (!intents.has(id)) intents.set(id, { id, amount: Number(params.get('amount')), status: 'requires_payment_method', client_secret: `${id}_secret` });
        return json(intents.get(id));
      }
      const m = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
      if (m) {
        const pi = intents.get(m[1]!);
        if (!pi) return json({ error: { message: 'No such payment_intent' } }, 404);
        if (m[2]) {
          if (pi.status === 'succeeded') return json({ error: { message: 'cannot cancel' } }, 400);
          pi.status = 'canceled';
        }
        return json(pi);
      }
      if (path === '/v1/refunds') return json({ id: `re_${randomUUID().slice(0, 8)}`, status: 'succeeded' });
      return json({ error: { message: `unhandled ${path}` } }, 404);
    }) as unknown as typeof fetch;
    return { intents, impl };
  }

  const secret = 'whsec_test_secret';
  const signed = (payload: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  };

  it('completes the sale when Stripe reports the payment succeeded', async () => {
    const stripe = fakeStripe();
    const stripeApp = await createTestApp({
      env: { PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: secret },
      providers: [[CARD_PROVIDER, new StripeCardProvider('sk_test_fake', { fetch: stripe.impl })]],
    });
    try {
      const { owner, mug, sell, stock } = await store(stripeApp);
      const sale = (await sell(owner, [{ variantId: mug.id, quantity: 1 }]).expect(201)).body;
      const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
      expect(card.payment.provider).toBe('stripe');
      expect(card.clientSecret).toMatch(/_secret$/);
      // The simulator endpoint is not available with a real provider.
      await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(404);

      // The reader collects the card; Stripe then notifies us.
      const piId = card.payment.providerRef as string;
      stripe.intents.get(piId)!.status = 'succeeded';
      const event = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: piId, object: 'payment_intent' } } });

      const server = stripeApp.getHttpServer();
      await request(server).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', 'bogus').send(event).expect(400);
      await request(server).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', signed(event)).send(event).expect(200);

      const after = (await owner.get(`/sales/${sale.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: 'completed', paidMinor: 1083 });
      expect(await stock()).toBe(9);

      const sql = adminSql();
      try {
        const [audit] = await sql`select actor_user_id from audit_log where action = 'sale.completed' and target_id = ${sale.id}`;
        expect(audit!.actor_user_id).toBeNull();
      } finally {
        await sql.end();
      }

      // Unknown intents are acknowledged and ignored.
      const unknown = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_nope', object: 'payment_intent' } } });
      await request(server).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', signed(unknown)).send(unknown).expect(200);
    } finally {
      await stripeApp.close();
    }
  });

  it('is disabled when payments are simulated', async () => {
    await request(app.getHttpServer()).post('/webhooks/stripe').send({}).expect(404);
  });
});

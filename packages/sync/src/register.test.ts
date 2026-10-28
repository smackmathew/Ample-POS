import { describe, expect, it } from 'vitest';
import { ApiClient, Cart, CatalogIndex, Checkout, formatMoney, parseMoney, quickCashAmounts, type CardReader, type CatalogVariant, type CollectResult } from './index';

const variant = (id: string, priceMinor: number, name = 'Default'): CatalogVariant => ({
  id,
  productId: `p-${id}`,
  productName: `Item ${id}`,
  name,
  sku: null,
  priceMinor,
  trackInventory: true,
  barcodes: [],
});

describe('Cart', () => {
  it('adds, merges repeat scans, changes quantities and totals before tax', () => {
    let cart = Cart.empty().add(variant('a', 350)).add(variant('b', 1200, 'Large')).add(variant('a', 350));
    expect(cart.lines.map((l) => [l.label, l.quantity])).toEqual([
      ['Item a', 2],
      ['Item b — Large', 1],
    ]);
    expect(cart.subtotalMinor).toBe(1900);
    cart = cart.setQuantity('b', 3).setQuantity('a', 0);
    expect(cart.lines).toEqual([{ variantId: 'b', label: 'Item b — Large', unitMinor: 1200, quantity: 3 }]);
    expect(cart.itemCount).toBe(3);
  });
});

describe('register helpers', () => {
  it('parses and formats money in cents', () => {
    expect(parseMoney('12')).toBe(1200);
    expect(parseMoney('$1,012.5')).toBe(101250);
    expect(parseMoney('1.234')).toBeNull();
    expect(formatMoney(101250)).toBe('$1,012.50');
  });

  it('searches the catalog by every word', () => {
    const index = new CatalogIndex([variant('mug', 1200, 'Blue'), variant('tee', 2000, 'Large')]);
    expect(index.search('item blu').map((v) => v.id)).toEqual(['mug']);
    expect(index.search('item').map((v) => v.id)).toEqual(['mug', 'tee']);
    expect(index.search('  ')).toEqual([]);
  });
});

describe('quickCashAmounts', () => {
  it('offers exact change and the next round amounts', () => {
    expect(quickCashAmounts(1337)).toEqual([1337, 1400, 1500, 2000]);
    expect(quickCashAmounts(2000)).toEqual([2000, 5000, 10_000]);
  });
});

/** A server holding one sale, with card payments that the test settles. */
function fakeServer() {
  const sale = {
    id: 'sale-1',
    status: 'open' as 'open' | 'completed',
    receiptNumber: null as number | null,
    currency: 'USD',
    subtotalMinor: 1000,
    discountMinor: 0,
    taxMinor: 100,
    totalMinor: 1100,
    paidMinor: 0,
    pendingMinor: 0,
    dueMinor: 1100,
    lines: [],
    payments: [] as { id: string; method: 'card' | 'cash'; status: 'pending' | 'succeeded' | 'canceled'; amountMinor: number; tenderedMinor: number | null; changeMinor: number | null; lastError: string | null }[],
  };
  const state = { processorOutcome: 'pending' as 'pending' | 'succeeded', declineMessage: null as string | null, dropSyncs: 0, calls: [] as string[] };
  const complete = () => {
    sale.paidMinor = sale.payments.filter((p) => p.status === 'succeeded').reduce((t, p) => t + p.amountMinor, 0);
    sale.pendingMinor = sale.payments.filter((p) => p.status === 'pending').reduce((t, p) => t + p.amountMinor, 0);
    sale.dueMinor = Math.max(0, sale.totalMinor - sale.paidMinor - sale.pendingMinor);
    if (sale.paidMinor >= sale.totalMinor) Object.assign(sale, { status: 'completed', receiptNumber: 42 });
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const impl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    state.calls.push(`${init?.method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/sales/sale-1/payments') {
      let p = sale.payments.find((x) => x.id === body.id);
      if (!p) {
        p =
          body.method === 'cash'
            ? { id: body.id, method: 'cash', status: 'succeeded', amountMinor: Math.min(body.tenderedMinor, sale.dueMinor), tenderedMinor: body.tenderedMinor, changeMinor: Math.max(0, body.tenderedMinor - sale.dueMinor), lastError: null }
            : { id: body.id, method: 'card', status: 'pending', amountMinor: sale.dueMinor, tenderedMinor: null, changeMinor: null, lastError: null };
        sale.payments.push(p);
        complete();
      }
      return json({ payment: p, clientSecret: p.method === 'card' && p.status === 'pending' ? `${p.id}_secret` : null, sale });
    }
    const m = /^\/sales\/sale-1\/payments\/([^/]+)\/(sync|cancel)$/.exec(path);
    if (m) {
      if (m[2] === 'sync' && state.dropSyncs > 0) {
        state.dropSyncs--;
        throw new TypeError('Network request failed');
      }
      const p = sale.payments.find((x) => x.id === m[1])!;
      if (p.status === 'pending') {
        if (state.processorOutcome === 'succeeded') p.status = 'succeeded';
        else if (m[2] === 'cancel') p.status = 'canceled';
        p.lastError = state.declineMessage;
      }
      complete();
      if (m[2] === 'cancel' && p.status === 'succeeded') return json({ message: 'The card payment had already gone through', sale }, 409);
      return json(sale);
    }
    return json({ message: `unhandled ${path}` }, 404);
  }) as unknown as typeof fetch;
  let n = 0;
  return { sale, state, checkout: new Checkout(new ApiClient({ baseUrl: 'http://pos.test', fetch: impl }), () => `pay-${++n}`) };
}

function reader(...results: CollectResult[]): CardReader & { secrets: string[] } {
  const secrets: string[] = [];
  return {
    secrets,
    async collect(secret) {
      secrets.push(secret);
      return results.shift()!;
    },
    async cancelCollect() {},
  };
}

describe('Checkout card payments', () => {
  it('marks the sale paid only once the server confirms it with the processor', async () => {
    const server = fakeServer();
    const r = reader({ status: 'approved' });
    server.state.processorOutcome = 'succeeded';
    const outcome = await server.checkout.payCard('sale-1', r);
    expect(outcome).toMatchObject({ status: 'paid', sale: { status: 'completed', receiptNumber: 42 } });
    expect(r.secrets).toEqual(['pay-1_secret']);
    expect(server.state.calls).toEqual(['POST /sales/sale-1/payments', 'POST /sales/sale-1/payments/pay-1/sync']);
  });

  it('does not trust a reader that says approved when the processor disagrees', async () => {
    const server = fakeServer();
    const outcome = await server.checkout.payCard('sale-1', reader({ status: 'approved' }));
    expect(outcome).toMatchObject({ status: 'retry', paymentId: 'pay-1' });
  });

  it('keeps a declined payment open so the same payment can be retried', async () => {
    const server = fakeServer();
    server.state.declineMessage = 'Your card was declined.';
    const r = reader({ status: 'declined', message: 'Declined by reader' }, { status: 'approved' });
    const first = await server.checkout.payCard('sale-1', r);
    expect(first).toEqual(expect.objectContaining({ status: 'retry', paymentId: 'pay-1', message: 'Your card was declined.' }));

    server.state.processorOutcome = 'succeeded';
    server.state.declineMessage = null;
    const second = await server.checkout.payCard('sale-1', r, 'pay-1');
    expect(second.status).toBe('paid');
    expect(r.secrets).toEqual(['pay-1_secret', 'pay-1_secret']);
    expect(server.sale.payments).toHaveLength(1);
  });

  it('cancels the payment when the card is not presented, unless it went through anyway', async () => {
    const server = fakeServer();
    const canceled = await server.checkout.payCard('sale-1', reader({ status: 'canceled', message: 'Canceled' }));
    expect(canceled.status).toBe('canceled');
    expect(server.sale.payments[0]!.status).toBe('canceled');
    expect(server.sale.dueMinor).toBe(1100);

    server.state.processorOutcome = 'succeeded';
    const raced = await server.checkout.payCard('sale-1', reader({ status: 'canceled', message: 'Canceled' }));
    expect(raced.status).toBe('canceled');
    expect(raced.sale.status).toBe('completed');
  });

  it('retries the confirmation when the connection drops right after the tap', async () => {
    const server = fakeServer();
    server.state.processorOutcome = 'succeeded';
    server.state.dropSyncs = 2;
    expect((await server.checkout.payCard('sale-1', reader({ status: 'approved' }))).status).toBe('paid');
  });

  it('records cash and returns the change', async () => {
    const server = fakeServer();
    const res = await server.checkout.payCash('sale-1', 2000);
    expect(res.changeMinor).toBe(900);
    expect(res.sale.status).toBe('completed');
  });
});

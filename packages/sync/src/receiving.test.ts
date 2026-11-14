import { describe, expect, it } from 'vitest';
import { ApiClient } from './api-client';
import { Receiving, ReceivingTally, type PurchaseOrderLine } from './receiving';

const line = (id: string, ordered: number, received = 0): PurchaseOrderLine => ({
  id,
  variantId: `v-${id}`,
  description: `Item ${id}`,
  sku: null,
  quantityOrdered: ordered,
  quantityReceived: received,
  unitCostMinor: 100,
  onHand: 0,
});

describe('ReceivingTally', () => {
  it('counts scans per line and reports what is still expected', () => {
    let tally = ReceivingTally.for({ lines: [line('a', 10, 4), line('b', 2)] });
    expect(tally.lineFor('v-a')?.id).toBe('a');
    expect(tally.lineFor('v-zzz')).toBeNull();
    tally = tally.add('a').add('a').add('b', 3);
    expect([tally.arrived('a'), tally.arrived('b'), tally.units]).toEqual([2, 3, 5]);
    expect(tally.outstanding(tally.lines[0]!)).toBe(4);
    expect(tally.outstanding(tally.lines[1]!)).toBe(0); // extra units are fine
    expect(() => tally.add('nope')).toThrow(RangeError);
  });

  it('sends only what arrived, and can fill in everything outstanding', () => {
    const base = ReceivingTally.for({ lines: [line('a', 10, 4), line('b', 2, 2), line('c', 1)] });
    expect(base.set('a', 3).set('a', 0).toLines()).toEqual([]);
    expect(base.add('c').toLines()).toEqual([{ lineId: 'c', quantity: 1 }]);
    expect(base.fillAll().toLines()).toEqual([
      { lineId: 'a', quantity: 6 },
      { lineId: 'c', quantity: 1 },
    ]);
    expect(base.set('a', -4).arrived('a')).toBe(0);
  });
});

describe('Receiving', () => {
  it('lists placed orders for the location and sends the delivery with its id', async () => {
    const calls: { method?: string; path: string; body?: unknown }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ method: init?.method, path: `${u.pathname}${u.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.pathname === '/purchase-orders') {
        return new Response(JSON.stringify([{ id: 'po-1', status: 'ordered' }, { id: 'po-2', status: 'draft' }, { id: 'po-3', status: 'partially_received' }]));
      }
      return new Response(JSON.stringify({ id: 'po-1', status: 'received', lines: [] }));
    }) as unknown as typeof fetch;
    const receiving = new Receiving(new ApiClient({ baseUrl: 'http://pos.test', fetch: impl }), () => 'delivery-1');
    expect((await receiving.openOrders('loc-1')).map((o) => o.id)).toEqual(['po-1', 'po-3']);
    expect(calls[0]!.path).toBe('/purchase-orders?status=open&locationId=loc-1');

    const tally = ReceivingTally.for({ lines: [line('a', 2)] }).add('a', 2);
    await receiving.receive('po-1', receiving.deliveryId(), tally, { updateCosts: false });
    expect(calls[1]).toEqual({ method: 'POST', path: '/purchase-orders/po-1/receive', body: { id: 'delivery-1', lines: [{ lineId: 'a', quantity: 2 }], updateCosts: false } });
  });
});

import { describe, expect, it } from 'vitest';
import { lookupKey, StripeBillingProvider } from './stripe-billing.provider';

function fakeStripe(responses: { status?: number; body: unknown }[]) {
  const calls: { method: string; url: string; body: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url: url.replace('https://api.stripe.com/v1', ''), body: decodeURIComponent(String(init.body ?? '')) });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected call ${init.method} ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const price = (id: string, moduleId: string, amount: number) => ({ id, lookup_key: lookupKey(moduleId, amount), metadata: { module_id: moduleId } });

describe('StripeBillingProvider', () => {
  it('creates missing prices once, then starts Checkout with the base item and a carried-over trial', async () => {
    const stripe = fakeStripe([
      { body: { data: [price('price_base', 'base', 0)] } },
      { body: { id: 'prod_pos' } },
      { body: { id: 'price_pos' } },
      { body: { url: 'https://checkout.stripe.com/c/1' } },
      { body: { url: 'https://checkout.stripe.com/c/2' } },
    ]);
    const provider = new StripeBillingProvider('sk_test', { fetch: stripe.impl });
    const input = {
      tenantId: 't1',
      customerId: 'cus_1',
      items: [{ moduleId: 'pos', quantity: 2 }],
      trialEnd: new Date('2026-07-01T00:00:00Z'),
      successUrl: 'https://hub/ok',
      cancelUrl: 'https://hub/no',
    };
    expect(await provider.startCheckout(input)).toEqual({ url: 'https://checkout.stripe.com/c/1' });

    expect(stripe.calls[0]!.url).toBe(`/prices?active=true&limit=100&lookup_keys[]=ample_base_0_usd_monthly&lookup_keys[]=ample_pos_4900_usd_monthly`);
    expect(stripe.calls[1]!.body).toBe('name=Ample POS – Point of sale&metadata[module_id]=pos');
    expect(stripe.calls[2]!.body).toBe(
      'product=prod_pos&currency=usd&unit_amount=4900&recurring[interval]=month&lookup_key=ample_pos_4900_usd_monthly&metadata[module_id]=pos',
    );
    expect(stripe.calls[3]!.body).toBe(
      'mode=subscription&customer=cus_1&client_reference_id=t1' +
        '&line_items[0][price]=price_base&line_items[0][quantity]=1&line_items[1][price]=price_pos&line_items[1][quantity]=2' +
        '&success_url=https://hub/ok&cancel_url=https://hub/no&subscription_data[metadata][tenant_id]=t1&subscription_data[trial_end]=1782864000',
    );

    // Prices are cached: the second checkout makes a single call.
    await provider.startCheckout({ ...input, trialEnd: null });
    expect(stripe.calls).toHaveLength(5);
    expect(stripe.calls[4]!.body).not.toContain('trial_end');
  });

  it('updates only what changed: quantities, removals and additions, leaving foreign items alone', async () => {
    const stripe = fakeStripe([
      {
        body: {
          id: 'sub_1',
          status: 'active',
          created: 1,
          cancel_at_period_end: false,
          items: {
            data: [
              { id: 'si_base', quantity: 1, price: price('price_base', 'base', 0) },
              { id: 'si_pos', quantity: 1, price: price('price_pos', 'pos', 4900) },
              { id: 'si_inv', quantity: 1, price: price('price_inv', 'inventory', 2900) },
              { id: 'si_other', quantity: 1, price: { id: 'price_x', lookup_key: null, metadata: {} } },
            ],
          },
        },
      },
      { body: { data: [price('price_tasks', 'tasks', 900)] } },
      {
        body: {
          id: 'sub_1',
          status: 'active',
          created: 1,
          cancel_at_period_end: false,
          items: {
            data: [
              { id: 'si_base', quantity: 1, current_period_end: 1782864000, price: price('price_base', 'base', 0) },
              { id: 'si_pos', quantity: 3, current_period_end: 1782864000, price: price('price_pos', 'pos', 4900) },
              { id: 'si_tasks', quantity: 3, current_period_end: 1782864000, price: price('price_tasks', 'tasks', 900) },
            ],
          },
        },
      },
    ]);
    const provider = new StripeBillingProvider('sk_test', { fetch: stripe.impl });
    const sub = { id: 'sub_1', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false, items: [] };
    const result = await provider.updateItems(
      sub,
      [
        { moduleId: 'pos', quantity: 3 },
        { moduleId: 'tasks', quantity: 3 },
      ],
      'items-abc',
    );

    expect(stripe.calls[2]).toMatchObject({ method: 'POST', url: '/subscriptions/sub_1' });
    expect(stripe.calls[2]!.body).toBe(
      'items[0][id]=si_pos&items[0][quantity]=3&items[1][id]=si_inv&items[1][deleted]=true' +
        '&items[2][price]=price_tasks&items[2][quantity]=3&proration_behavior=create_prorations',
    );
    // The period end comes from the items on newer API versions; the base item is not a tool.
    expect(result).toEqual({
      id: 'sub_1',
      status: 'active',
      currentPeriodEnd: new Date(1782864000 * 1000),
      cancelAtPeriodEnd: false,
      items: [
        { moduleId: 'pos', quantity: 3 },
        { moduleId: 'tasks', quantity: 3 },
      ],
    });
  });

  it('makes no update call when nothing changed', async () => {
    const current = {
      id: 'sub_1',
      status: 'active',
      created: 1,
      cancel_at_period_end: false,
      current_period_end: 1782864000,
      items: { data: [{ id: 'si_base', quantity: 1, price: price('price_base', 'base', 0) }, { id: 'si_pos', quantity: 2, price: price('price_pos', 'pos', 4900) }] },
    };
    const stripe = fakeStripe([{ body: current }]);
    const provider = new StripeBillingProvider('sk_test', { fetch: stripe.impl });
    await provider.updateItems({ id: 'sub_1', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false, items: [] }, [{ moduleId: 'pos', quantity: 2 }], 'k');
    expect(stripe.calls).toHaveLength(1);
  });

  it('picks the open subscription over older canceled ones', async () => {
    const sub = (id: string, status: string, created: number) => ({ id, status, created, cancel_at_period_end: false, current_period_end: 1782864000, items: { data: [] } });
    const stripe = fakeStripe([
      { body: { data: [sub('sub_old', 'canceled', 1), sub('sub_new', 'past_due', 2), sub('sub_newest', 'canceled', 3)] } },
      { body: { data: [sub('sub_a', 'canceled', 1), sub('sub_b', 'canceled', 5)] } },
      { body: { data: [] } },
    ]);
    const provider = new StripeBillingProvider('sk_test', { fetch: stripe.impl });
    expect(await provider.currentSubscription('cus_1')).toMatchObject({ id: 'sub_new', status: 'past_due' });
    expect(stripe.calls[0]!.url).toBe('/subscriptions?customer=cus_1&status=all&limit=20');
    expect(await provider.currentSubscription('cus_1')).toMatchObject({ id: 'sub_b', status: 'canceled' });
    expect(await provider.currentSubscription('cus_1')).toBeNull();
  });
});

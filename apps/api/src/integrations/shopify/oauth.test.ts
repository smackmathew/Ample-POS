import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, exchangeCode, verifyCallbackHmac } from './oauth';

describe('Shopify OAuth helpers', () => {
  it('builds the approval URL', () => {
    const url = new URL(authorizeUrl({ shop: 'maple.myshopify.com', clientId: 'cid', redirectUri: 'https://pos.example/shopify/callback', state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://maple.myshopify.com/admin/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      scope: 'read_products,read_orders,read_locations,read_inventory,write_inventory',
      redirect_uri: 'https://pos.example/shopify/callback',
      state: 's1',
    });
  });

  it('verifies the callback hmac over the sorted parameters', () => {
    const params = { code: 'abc', shop: 'maple.myshopify.com', state: 's1', timestamp: '1800000000', host: 'aG9zdA' };
    const message = 'code=abc&host=aG9zdA&shop=maple.myshopify.com&state=s1&timestamp=1800000000';
    const hmac = createHmac('sha256', 'secret').update(message).digest('hex');
    expect(verifyCallbackHmac({ ...params, hmac }, 'secret')).toBe(true);
    expect(verifyCallbackHmac({ ...params, shop: 'evil.myshopify.com', hmac }, 'secret')).toBe(false);
    expect(verifyCallbackHmac({ ...params, hmac }, 'other-secret')).toBe(false);
    expect(verifyCallbackHmac(params, 'secret')).toBe(false);
  });

  it('asks for an expiring offline token and reports refusals', async () => {
    let sent = '';
    const ok = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, refresh_token_expires_in: 7776000, scope: 'read_products' }));
    }) as unknown as typeof fetch;
    const tokens = await exchangeCode(ok, { shop: 'm.myshopify.com', clientId: 'cid', clientSecret: 'cs', code: 'c1' });
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope: 'read_products' });
    expect(Object.fromEntries(new URLSearchParams(sent))).toEqual({ client_id: 'cid', client_secret: 'cs', code: 'c1', expiring: '1' });

    const refused = (async () => new Response(JSON.stringify({ error: 'invalid_request', error_description: 'code already used' }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(refused, { shop: 'm.myshopify.com', clientId: 'cid', clientSecret: 'cs', code: 'c1' })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('code already used'),
    });
  });
});

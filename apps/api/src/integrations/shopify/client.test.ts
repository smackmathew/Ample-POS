import { describe, expect, it } from 'vitest';
import { ShopifyClient, ShopifyError } from './client';

const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('ShopifyClient errors', () => {
  it('reports an unknown store clearly (Shopify sends errors as a string)', async () => {
    const client = new ShopifyClient('nope.myshopify.com', 'tok', respond(404, { errors: 'Not Found' }));
    await expect(client.shop()).rejects.toThrow('Store not found (Not Found)');
  });

  it('marks throttling and server errors as retryable, bad tokens as not', async () => {
    const throttled = new ShopifyClient('s.myshopify.com', 'tok', respond(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }));
    await expect(throttled.shop()).rejects.toMatchObject({ retryable: true });
    await expect(new ShopifyClient('s.myshopify.com', 'tok', respond(503, {})).shop()).rejects.toMatchObject({ retryable: true });
    await expect(new ShopifyClient('s.myshopify.com', 'tok', respond(401, { errors: 'Invalid API key' })).shop()).rejects.toMatchObject({ retryable: false });
    await expect(new ShopifyClient('s.myshopify.com', 'tok', respond(200, { errors: { query: 'bad' } })).shop()).rejects.toBeInstanceOf(ShopifyError);
  });

  it('treats network failures as retryable', async () => {
    const client = new ShopifyClient('s.myshopify.com', 'tok', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(client.shop()).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('Could not reach Shopify') });
  });
});

import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, CatalogIndex, MemoryEntryStore, parsePairingCode, SyncEngine } from './index';

const COUNT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';

/** A fake server reachable through ApiClient's injectable fetch. */
function fakeServer() {
  const received = new Map<string, number>();
  const voided = new Set<string>();
  const state = { offline: false, loseResponses: false, status: 0, calls: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    state.calls++;
    if (state.offline) throw new TypeError('Network request failed');
    if (state.status) return new Response(JSON.stringify({ message: 'nope' }), { status: state.status });
    const path = new URL(url).pathname;
    const voidMatch = /entries\/([^/]+)\/void$/.exec(path);
    if (voidMatch) {
      if (voided.has(voidMatch[1]!) || !received.has(voidMatch[1]!)) return new Response('{}', { status: 404 });
      voided.add(voidMatch[1]!);
    } else {
      const body = JSON.parse(String(init!.body)) as { entries: { id: string; quantity: number }[] };
      for (const e of body.entries) if (!received.has(e.id)) received.set(e.id, e.quantity);
    }
    if (state.loseResponses) throw new TypeError('Connection reset');
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  const total = () => [...received].filter(([id]) => !voided.has(id)).reduce((n, [, q]) => n + q, 0);
  return { state, received, voided, total, api: new ApiClient({ baseUrl: 'http://pos.test', fetch: fetchImpl }) };
}

const scan = (engine: SyncEngine, id: string, quantity = 1) =>
  engine.record({ id, countId: COUNT, variantId: VARIANT, label: 'Mug', quantity });

describe('SyncEngine', () => {
  it('keeps entries while offline and delivers them once back online', async () => {
    const server = fakeServer();
    const store = new MemoryEntryStore();
    const engine = new SyncEngine(store, server.api);
    server.state.offline = true;
    await scan(engine, 'a', 2);
    await scan(engine, 'b', 3);
    expect(await engine.flush()).toEqual({ sent: 0, failed: 0, stopped: 'offline' });
    expect(await engine.status(COUNT)).toEqual({ pending: 2, failed: 0 });

    server.state.offline = false;
    expect(await engine.flush()).toEqual({ sent: 2, failed: 0 });
    expect(server.total()).toBe(5);
    expect(await engine.status(COUNT)).toEqual({ pending: 0, failed: 0 });
  });

  it('resends after a lost response without double counting', async () => {
    const server = fakeServer();
    const engine = new SyncEngine(new MemoryEntryStore(), server.api);
    await scan(engine, 'a', 4);
    server.state.loseResponses = true;
    expect((await engine.flush()).stopped).toBe('offline');
    server.state.loseResponses = false;
    await engine.flush();
    expect(server.total()).toBe(4);
  });

  it('never sends an entry undone before it synced, and voids one that had', async () => {
    const server = fakeServer();
    const engine = new SyncEngine(new MemoryEntryStore(), server.api);
    await scan(engine, 'local-only', 9);
    await engine.void('local-only');
    await scan(engine, 'sent', 5);
    await engine.flush();
    expect([...server.received.keys()]).toEqual(['sent']);

    await engine.void('sent');
    expect(await engine.status(COUNT)).toEqual({ pending: 1, failed: 0 });
    await engine.flush();
    expect(server.total()).toBe(0);
    // A void whose earlier response was lost comes back 404 and counts as done.
    expect(await engine.flush()).toEqual({ sent: 0, failed: 0 });
  });

  it('marks entries failed when the server refuses them for good', async () => {
    const server = fakeServer();
    const engine = new SyncEngine(new MemoryEntryStore(), server.api);
    await scan(engine, 'a');
    server.state.status = 409; // e.g. the count was submitted from the web
    expect(await engine.flush()).toEqual({ sent: 0, failed: 1 });
    expect(await engine.status(COUNT)).toEqual({ pending: 0, failed: 1 });
  });

  it('stops without discarding work on 401, 402 or server errors', async () => {
    const server = fakeServer();
    const engine = new SyncEngine(new MemoryEntryStore(), server.api);
    await scan(engine, 'a');
    server.state.status = 401;
    expect((await engine.flush()).stopped).toBe('unauthorized');
    server.state.status = 402;
    expect((await engine.flush()).stopped).toBe('subscription_required');
    server.state.status = 503;
    expect((await engine.flush()).stopped).toBe('offline');
    server.state.status = 0;
    expect(await engine.flush()).toEqual({ sent: 1, failed: 0 });
  });

  it('shares one flush between concurrent callers', async () => {
    const server = fakeServer();
    const engine = new SyncEngine(new MemoryEntryStore(), server.api);
    await scan(engine, 'a');
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);
    expect(server.state.calls).toBe(1);
  });
});

describe('ApiClient', () => {
  it('surfaces the server message on errors', async () => {
    const server = fakeServer();
    server.state.status = 403;
    await expect(server.api.get('/x')).rejects.toEqual(expect.objectContaining({ status: 403, message: 'nope' }));
    await expect(server.api.get('/x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('parsePairingCode', () => {
  const valid = { v: 1, api: 'http://192.168.1.20:4000', tenantId: COUNT, credential: `${VARIANT}.s3cret` };

  it('accepts codes from the admin hub', () => {
    expect(parsePairingCode(JSON.stringify(valid))).toEqual({ api: valid.api, tenantId: COUNT, credential: valid.credential });
  });

  it.each([
    ['not json', 'hello'],
    ['a product barcode', '0123456789012'],
    ['wrong version', JSON.stringify({ ...valid, v: 2 })],
    ['bad api url', JSON.stringify({ ...valid, api: 'javascript:alert(1)' })],
    ['bad credential', JSON.stringify({ ...valid, credential: 'abc' })],
  ])('rejects %s', (_, text) => {
    expect(parsePairingCode(text)).toBeNull();
  });
});

describe('CatalogIndex', () => {
  it('finds by exact barcode or case-insensitive SKU', () => {
    const v = { id: 'v1', productId: 'p1', productName: 'Mug', name: 'Default', sku: 'MUG-1', priceMinor: 100, trackInventory: true, barcodes: ['0001'] };
    const index = new CatalogIndex([v]);
    expect(index.find(' 0001 ')?.id).toBe('v1');
    expect(index.find('mug-1')?.id).toBe('v1');
    expect(index.find('0002')).toBeNull();
    expect(index.size).toBe(1);
  });
});

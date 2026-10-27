import { createHmac } from 'node:crypto';

/**
 * In-memory stand-in for the Shopify Admin GraphQL API, routed by operation
 * name. It mimics what matters for sync: compare-and-swap on inventory, the
 * required idempotency key, orders that decrement Shopify's own stock, and
 * signed webhooks.
 */
export class FakeShopify {
  readonly domain = 'maple-test.myshopify.com';
  readonly token = 'shpat_test_token_123';
  readonly webhookSecret = 'shopify_webhook_secret_123';
  currency = 'USD';
  locations = [
    { id: 'gid://shopify/Location/1', name: 'Shopify Warehouse', isActive: true },
    { id: 'gid://shopify/Location/2', name: 'Pop-up', isActive: true },
  ];
  products: FakeProduct[] = [];
  orders = new Map<string, FakeOrder>();
  /** `${inventoryItemId}|${locationId}` → available */
  levels = new Map<string, number>();
  readonly clientId = 'ample-client-id';
  readonly clientSecret = 'ample-client-secret';
  /** Codes Shopify would hand back after a merchant approves the app. */
  validCodes = new Set(['approval-code-1']);
  /** Access tokens issued through OAuth, and the refresh tokens still usable. */
  issued = new Set<string>();
  refreshTokens = new Set<string>();
  /** Seconds the next issued access token lasts. */
  accessTokenTtl = 3600;
  tokenRequests: Record<string, string>[] = [];
  setCalls: { key: string; quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number | null }[] }[] = [];
  webhooks: { topic: string; uri: string }[] = [];
  private idempotent = new Map<string, unknown>();
  private seq = 100;

  fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) === `https://${this.domain}/admin/oauth/access_token`) return this.tokenEndpoint(String(init?.body));
    if (!String(url).startsWith(`https://${this.domain}/admin/api/`)) throw new TypeError('getaddrinfo ENOTFOUND');
    const token = (init?.headers as Record<string, string>)['X-Shopify-Access-Token'];
    if (token !== this.token && !this.issued.has(token!)) {
      return new Response(JSON.stringify({ errors: '[API] Invalid API key or access token' }), { status: 401 });
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    return new Response(JSON.stringify({ data: this.handle(op ?? '', variables) }), { status: 200 });
  }) as typeof fetch;

  private tokenEndpoint(body: string): Response {
    const form = Object.fromEntries(new URLSearchParams(body));
    this.tokenRequests.push(form);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (form.client_id !== this.clientId || form.client_secret !== this.clientSecret) return json({ error: 'invalid_client' }, 401);
    let ok = false;
    if (form.grant_type === 'refresh_token') {
      ok = this.refreshTokens.delete(form.refresh_token!);
    } else if (form.code && this.validCodes.delete(form.code)) {
      ok = form.expiring === '1';
    }
    if (!ok) return json({ error: 'invalid_request', error_description: 'The code or refresh token is not valid' }, 400);
    const access = `shpua_${this.seq++}`;
    const refresh = `shprt_${this.seq++}`;
    this.issued.add(access);
    this.refreshTokens.add(refresh);
    return json({ access_token: access, refresh_token: refresh, expires_in: this.accessTokenTtl, refresh_token_expires_in: 7776000, scope: 'read_products' });
  }

  /** Simulates every OAuth access token reaching its expiry. */
  expireAccessTokens() {
    this.issued.clear();
  }

  private handle(op: string, v: Record<string, unknown>): unknown {
    switch (op) {
      case 'AmpleShop':
        return { shop: { name: 'Maple Test', currencyCode: this.currency } };
      case 'AmpleLocations':
        return { locations: { nodes: this.locations } };
      case 'AmpleProducts': {
        // Two per page, to exercise pagination.
        const start = v.after ? Number(v.after) : 0;
        const page = this.products.slice(start, start + 2);
        const more = start + 2 < this.products.length;
        return { products: { nodes: page.map((p) => this.raw(p)), pageInfo: { hasNextPage: more, endCursor: more ? String(start + 2) : null } } };
      }
      case 'AmpleProduct': {
        const p = this.products.find((x) => x.id === v.id);
        return { product: p ? this.raw(p) : null };
      }
      case 'AmpleOrder': {
        const o = this.orders.get(v.id as string);
        return { order: o ? this.rawOrder(o) : null };
      }
      case 'AmpleOrders':
        return { orders: { nodes: [...this.orders.values()].map((o) => this.rawOrder(o)), pageInfo: { hasNextPage: false, endCursor: null } } };
      case 'AmpleInventoryLevel': {
        const q = this.levels.get(`${v.item}|${v.location}`);
        return { inventoryItem: { inventoryLevel: q === undefined ? null : { quantities: [{ name: 'available', quantity: q }] } } };
      }
      case 'AmpleSetAvailable': {
        const key = v.key as string;
        if (!key) return { inventorySetQuantities: { userErrors: [{ code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH', field: null, message: 'key required' }] } };
        if (this.idempotent.has(key)) return this.idempotent.get(key);
        const input = v.input as { name: string; quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number | null }[] };
        this.setCalls.push({ key, quantities: input.quantities });
        const stale = input.quantities.find((q) => q.changeFromQuantity !== null && (this.levels.get(`${q.inventoryItemId}|${q.locationId}`) ?? 0) !== q.changeFromQuantity);
        const result = stale
          ? { inventorySetQuantities: { userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', field: ['input', 'quantities'], message: 'The quantity has changed' }] } }
          : { inventorySetQuantities: { userErrors: [] } };
        if (!stale) for (const q of input.quantities) this.levels.set(`${q.inventoryItemId}|${q.locationId}`, q.quantity);
        this.idempotent.set(key, result);
        return result;
      }
      case 'AmpleWebhookCreate':
        this.webhooks.push({ topic: v.topic as string, uri: v.uri as string });
        return { webhookSubscriptionCreate: { userErrors: [] } };
      default:
        throw new Error(`FakeShopify: unhandled operation ${op}`);
    }
  }

  addProduct(title: string, variants: { title?: string; sku?: string; price: string; barcode?: string; tracked?: boolean }[], status = 'ACTIVE'): FakeProduct {
    const id = `gid://shopify/Product/${this.seq++}`;
    const product: FakeProduct = {
      id,
      title,
      status,
      productType: 'Goods',
      variants: variants.map((x) => ({
        id: `gid://shopify/ProductVariant/${this.seq++}`,
        title: x.title ?? 'Default Title',
        sku: x.sku ?? '',
        price: x.price,
        barcodes: x.barcode ? [x.barcode] : [],
        inventoryItemId: `gid://shopify/InventoryItem/${this.seq++}`,
        tracked: x.tracked ?? true,
      })),
    };
    this.products.push(product);
    return product;
  }

  /** A customer buys online: Shopify lowers its own stock at the location. */
  placeOrder(lines: { variant: FakeVariant; quantity: number }[], locationId = this.locations[0]!.id): FakeOrder {
    const order: FakeOrder = { id: `gid://shopify/Order/${this.seq++}`, name: `#${1000 + this.orders.size + 1}`, cancelledAt: null, lines };
    for (const l of lines) {
      const k = `${l.variant.inventoryItemId}|${locationId}`;
      this.levels.set(k, (this.levels.get(k) ?? 0) - l.quantity);
    }
    this.orders.set(order.id, order);
    return order;
  }

  cancelOrder(order: FakeOrder, locationId = this.locations[0]!.id) {
    order.cancelledAt = new Date().toISOString();
    for (const l of order.lines) {
      const k = `${l.variant.inventoryItemId}|${locationId}`;
      this.levels.set(k, (this.levels.get(k) ?? 0) + l.quantity);
    }
  }

  level(variant: FakeVariant, locationId = this.locations[0]!.id) {
    return this.levels.get(`${variant.inventoryItemId}|${locationId}`);
  }

  /** Body and headers Shopify would send for a webhook. */
  webhook(topic: string, resourceGid: string, webhookId = `wh_${this.seq++}`, secret = this.webhookSecret) {
    const body = JSON.stringify({ id: Number(resourceGid.split('/').pop()), admin_graphql_api_id: resourceGid });
    return {
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Hmac-Sha256': createHmac('sha256', secret).update(body).digest('base64'),
      },
    };
  }

  private raw(p: FakeProduct) {
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      productType: p.productType,
      variants: {
        nodes: p.variants.map((x) => ({
          id: x.id,
          title: x.title,
          sku: x.sku,
          price: x.price,
          barcodes: { nodes: x.barcodes.map((value) => ({ value })) },
          inventoryItem: { id: x.inventoryItemId, tracked: x.tracked },
        })),
      },
    };
  }

  private rawOrder(o: FakeOrder) {
    return { id: o.id, name: o.name, cancelledAt: o.cancelledAt, lineItems: { nodes: o.lines.map((l) => ({ quantity: l.quantity, variant: { id: l.variant.id } })) } };
  }
}

export interface FakeVariant {
  id: string;
  title: string;
  sku: string;
  price: string;
  barcodes: string[];
  inventoryItemId: string;
  tracked: boolean;
}

export interface FakeProduct {
  id: string;
  title: string;
  status: string;
  productType: string;
  variants: FakeVariant[];
}

export interface FakeOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  lines: { variant: FakeVariant; quantity: number }[];
}

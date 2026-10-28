/** Admin GraphQL API version this integration is written against. */
export const SHOPIFY_API_VERSION = '2026-10';

export class ShopifyError extends Error {
  constructor(
    message: string,
    /** Retryable: throttled, 5xx, or the network. */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  barcodes: string[];
  inventoryItemId: string;
  tracked: boolean;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | string;
  productType: string;
  variants: ShopifyVariant[];
}

export interface ShopifyOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  lines: { variantId: string | null; quantity: number }[];
}

export interface SetQuantity {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  /** Compare-and-swap: fail if the store's current value differs. Null opts out. */
  changeFromQuantity: number | null;
}

const PRODUCT_FIELDS = `
  id title status productType
  variants(first: 100) {
    nodes {
      id title sku price
      barcodes(first: 10) { nodes { value } }
      inventoryItem { id tracked }
    }
  }`;

interface RawProduct {
  id: string;
  title: string;
  status: string;
  productType: string;
  variants: {
    nodes: { id: string; title: string; sku: string | null; price: string; barcodes: { nodes: { value: string }[] }; inventoryItem: { id: string; tracked: boolean } }[];
  };
}

const toProduct = (p: RawProduct): ShopifyProduct => ({
  id: p.id,
  title: p.title,
  status: p.status,
  productType: p.productType,
  variants: p.variants.nodes.map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku || null,
    price: v.price,
    barcodes: v.barcodes.nodes.map((b) => b.value).filter(Boolean),
    inventoryItemId: v.inventoryItem.id,
    tracked: v.inventoryItem.tracked,
  })),
});

interface RawOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  lineItems: { nodes: { quantity: number; variant: { id: string } | null }[] };
}

const toOrder = (o: RawOrder): ShopifyOrder => ({
  id: o.id,
  name: o.name,
  cancelledAt: o.cancelledAt,
  lines: o.lineItems.nodes.map((l) => ({ variantId: l.variant?.id ?? null, quantity: l.quantity })),
});

const ORDER_FIELDS = `id name cancelledAt lineItems(first: 250) { nodes { quantity variant { id } } }`;

/** Thin client for the Shopify Admin GraphQL API with a custom-app access token. */
export class ShopifyClient {
  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.accessToken },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new ShopifyError(`Could not reach Shopify: ${(err as Error).message}`, true);
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyError('Shopify rejected the access token', false, res.status);
    if (res.status === 429 || res.status >= 500) throw new ShopifyError(`Shopify returned ${res.status}`, true, res.status);
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
    // GraphQL errors are a list; Shopify's HTTP-level errors (e.g. unknown store → 404) are a plain string.
    const errors = Array.isArray(body.errors)
      ? (body.errors as { message?: string; extensions?: { code?: string } }[])
      : body.errors
        ? [{ message: typeof body.errors === 'string' ? body.errors : JSON.stringify(body.errors) }]
        : [];
    if (res.status === 404) throw new ShopifyError(`Store not found (${errors[0]?.message ?? 'Not Found'})`, false, 404);
    if (errors.length) {
      const throttled = errors.some((e) => e.extensions?.code === 'THROTTLED');
      throw new ShopifyError(errors.map((e) => e.message ?? 'Unknown error').join('; '), throttled);
    }
    if (!res.ok || !body.data) throw new ShopifyError(`Shopify returned ${res.status}`, false, res.status);
    return body.data;
  }

  async shop() {
    const data = await this.graphql<{ shop: { name: string; currencyCode: string } }>(`query AmpleShop { shop { name currencyCode } }`);
    return data.shop;
  }

  async locations() {
    const data = await this.graphql<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(
      `query AmpleLocations { locations(first: 100) { nodes { id name isActive } } }`,
    );
    return data.locations.nodes;
  }

  async *products(): AsyncGenerator<ShopifyProduct> {
    let after: string | null = null;
    do {
      const data: { products: { nodes: RawProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(
        `query AmpleProducts($after: String) { products(first: 50, after: $after) { nodes { ${PRODUCT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
      for (const p of data.products.nodes) yield toProduct(p);
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);
  }

  async product(id: string): Promise<ShopifyProduct | null> {
    const data = await this.graphql<{ product: RawProduct | null }>(`query AmpleProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
    return data.product ? toProduct(data.product) : null;
  }

  async order(id: string): Promise<ShopifyOrder | null> {
    const data = await this.graphql<{ order: RawOrder | null }>(`query AmpleOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
    return data.order ? toOrder(data.order) : null;
  }

  /** Orders updated since `since`, oldest first, for reconciling missed webhooks. */
  async *ordersUpdatedSince(since: Date): AsyncGenerator<ShopifyOrder> {
    let after: string | null = null;
    const query = `updated_at:>='${since.toISOString()}'`;
    do {
      const data: { orders: { nodes: RawOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(
        `query AmpleOrders($after: String, $query: String) { orders(first: 50, after: $after, query: $query, sortKey: UPDATED_AT) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { after, query },
      );
      for (const o of data.orders.nodes) yield toOrder(o);
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (after);
  }

  /** Current "available" quantity of an item at a location (null if not stocked there). */
  async available(inventoryItemId: string, locationId: string): Promise<number | null> {
    const data = await this.graphql<{ inventoryItem: { inventoryLevel: { quantities: { name: string; quantity: number }[] } | null } | null }>(
      `query AmpleInventoryLevel($item: ID!, $location: ID!) {
        inventoryItem(id: $item) { inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
      }`,
      { item: inventoryItemId, location: locationId },
    );
    return data.inventoryItem?.inventoryLevel?.quantities.find((q) => q.name === 'available')?.quantity ?? null;
  }

  /**
   * Sets "available" quantities with compare-and-swap. Shopify requires an
   * idempotency key (2026-04+); reuse it when retrying the same change.
   */
  async setAvailable(quantities: SetQuantity[], idempotencyKey: string, referenceDocumentUri: string) {
    const data = await this.graphql<{ inventorySetQuantities: { userErrors: { code: string | null; field: string[] | null; message: string }[] } }>(
      `mutation AmpleSetAvailable($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
      }`,
      { input: { name: 'available', reason: 'correction', referenceDocumentUri, quantities }, key: idempotencyKey },
    );
    return data.inventorySetQuantities.userErrors;
  }

  async createWebhook(topic: string, uri: string) {
    const data = await this.graphql<{ webhookSubscriptionCreate: { userErrors: { field: string[] | null; message: string }[] } }>(
      `mutation AmpleWebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { userErrors { field message } }
      }`,
      { topic, uri },
    );
    return data.webhookSubscriptionCreate.userErrors;
  }
}

/** The fetch used for every Shopify request; tests point it at a fake Shopify. */
export const SHOPIFY_FETCH = Symbol('SHOPIFY_FETCH');

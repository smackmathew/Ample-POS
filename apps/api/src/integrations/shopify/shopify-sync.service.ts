import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { Db } from '../../core/database';
import { Events } from '../../core/events';
import { currentTenant, currentUserId } from '../../core/request-context';
import { SECRET_BOX, type SecretBox } from '../../core/secrets';
import { LedgerService } from '../../inventory/ledger.service';
import { ShopifyClient, ShopifyError, SHOPIFY_FETCH, type ShopifyOrder, type ShopifyProduct } from './client';
import { authorizeUrl, exchangeCode, refreshTokens, SHOP_DOMAIN, verifyCallbackHmac, type OAuthTokens } from './oauth';

type Connection = typeof schema.integrationConnections.$inferSelect;

/**
 * oauth: installed through "Connect with Shopify"; the token expires hourly and
 *        is refreshed automatically; webhooks are signed with the app's secret.
 * token: pasted from an existing admin-created custom app (non-expiring).
 */
type Credentials = ({ kind: 'oauth' } & OAuthTokens) | { kind?: 'token'; accessToken: string; webhookSecret: string };

interface OAuthState {
  tenantId: string;
  userId: string;
  shop: string;
  nonce: string;
  exp: number;
}

/** Refresh a little early so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Topics whose events can change stock levels and should be pushed to the store. */
export const STOCK_TOPICS = [
  'inventory.received',
  'inventory.adjusted',
  'inventory.transferred',
  'count.approved',
  'sale.completed',
  'sale.refunded',
  'inventory.online_order',
];

export const WEBHOOK_TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'ORDERS_CREATE', 'ORDERS_CANCELLED', 'APP_UNINSTALLED'];

/** Shopify money strings ("12.5", "12.50") to minor units. */
export function parseShopifyMoney(value: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

const variantName = (title: string) => (title === 'Default Title' ? 'Default' : title);

/** Collects variant ids mentioned in an outbox payload (lines[] or adjustments[]). */
export function variantIdsIn(payload: Record<string, unknown>): string[] {
  const lists = [payload.lines, payload.adjustments].filter(Array.isArray) as { variantId?: unknown }[][];
  return [...new Set(lists.flat().map((l) => l.variantId).filter((v): v is string => typeof v === 'string'))];
}

export interface PushResult {
  /** Items we had no stock record for: we adopted Shopify's quantity instead of pushing zero. */
  seeded: number;
  pushed: number;
  unchanged: number;
  conflicts: number;
  failed: number;
}

/**
 * Keeps a business in step with one Shopify store:
 *  - catalog: imported from Shopify (Shopify owns names, SKUs, barcodes, prices)
 *  - stock:   pushed to Shopify's mapped locations (Ample POS owns quantities)
 *  - orders:  online orders become stock movements at the chosen location
 * Runs inside a request or system transaction for one business.
 */
@Injectable()
export class ShopifySyncService {
  private readonly logger = new Logger('ShopifySync');

  constructor(
    private readonly db: Db,
    private readonly events: Events,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_BOX) private readonly secrets: SecretBox | null,
    @Inject(SHOPIFY_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  // Connection ---------------------------------------------------------------

  async connection(): Promise<Connection | null> {
    const [conn] = await this.db.tx
      .select()
      .from(schema.integrationConnections)
      .where(and(eq(schema.integrationConnections.provider, 'shopify'), ne(schema.integrationConnections.status, 'disconnected')));
    return conn ?? null;
  }

  async requireConnection(): Promise<Connection> {
    const conn = await this.connection();
    if (!conn) throw new NotFoundException('Connect a Shopify store first');
    return conn;
  }

  /** Connects with a token from an existing admin-created custom app. */
  async connect(input: { shopDomain: string; accessToken: string; webhookSecret: string }) {
    return this.createConnection(input.shopDomain, { kind: 'token', accessToken: input.accessToken, webhookSecret: input.webhookSecret });
  }

  get oauthEnabled(): boolean {
    return Boolean(this.config.SHOPIFY_CLIENT_ID && this.config.SHOPIFY_CLIENT_SECRET && this.secrets);
  }

  /**
   * Step 1 of "Connect with Shopify": a sealed state naming this business, user
   * and store, and the Shopify approval URL. The web app keeps `nonce` in a
   * cookie so the callback can prove it returns to the browser that started it.
   */
  startOAuth(shopDomain: string) {
    if (!this.oauthEnabled) throw new ServiceUnavailableException('Connect with Shopify is not set up on this server (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)');
    const nonce = randomBytes(16).toString('hex');
    const state: OAuthState = { tenantId: currentTenant().tenantId, userId: currentUserId(), shop: shopDomain, nonce, exp: Date.now() + 10 * 60_000 };
    return {
      nonce,
      authorizeUrl: authorizeUrl({
        shop: shopDomain,
        clientId: this.config.SHOPIFY_CLIENT_ID!,
        redirectUri: `${this.config.WEB_URL.replace(/\/+$/, '')}/shopify/callback`,
        state: this.box().seal(state),
      }),
    };
  }

  /** Step 2: verify Shopify's redirect, check it belongs to this user's flow, exchange the code. */
  async completeOAuth(params: Record<string, string>, nonce: string) {
    if (!this.oauthEnabled) throw new ServiceUnavailableException('Connect with Shopify is not set up on this server');
    if (!verifyCallbackHmac(params, this.config.SHOPIFY_CLIENT_SECRET!)) throw new BadRequestException('The response from Shopify could not be verified');
    let state: OAuthState;
    try {
      state = this.box().open<OAuthState>(params.state ?? '');
    } catch {
      throw new BadRequestException('This Shopify link is invalid. Start connecting again.');
    }
    if (state.exp < Date.now()) throw new BadRequestException('This Shopify link has expired. Start connecting again.');
    if (state.nonce !== nonce || state.userId !== currentUserId() || state.tenantId !== currentTenant().tenantId) {
      throw new BadRequestException('This Shopify approval was started by someone else. Start connecting again.');
    }
    if (params.shop !== state.shop || !SHOP_DOMAIN.test(params.shop ?? '')) throw new BadRequestException('Shopify returned a different store');
    if (!params.code) throw new BadRequestException('Shopify did not return an approval code');

    const tokens = await exchangeCode(this.fetchImpl, {
      shop: state.shop,
      clientId: this.config.SHOPIFY_CLIENT_ID!,
      clientSecret: this.config.SHOPIFY_CLIENT_SECRET!,
      code: params.code,
    }).catch((err) => {
      throw this.asHttpError(err);
    });
    return this.createConnection(state.shop, { kind: 'oauth', ...tokens });
  }

  private async createConnection(shopDomain: string, credentials: Credentials) {
    const box = this.box();
    if (await this.connection()) throw new ConflictException('A Shopify store is already connected. Disconnect it first.');
    const client = new ShopifyClient(shopDomain, credentials.accessToken, this.fetchImpl);
    let shop: { name: string; currencyCode: string };
    try {
      shop = await client.shop();
    } catch (err) {
      throw new BadRequestException(`Could not connect to ${shopDomain}: ${(err as Error).message}`);
    }
    const [tenant] = await this.db.tx.select({ currency: schema.tenants.currency }).from(schema.tenants);
    if (shop.currencyCode !== tenant!.currency) {
      throw new BadRequestException(`${shop.name} sells in ${shop.currencyCode} but this business uses ${tenant!.currency}`);
    }
    const [conn] = await this.db.tx
      .insert(schema.integrationConnections)
      .values({
        tenantId: currentTenant().tenantId,
        provider: 'shopify',
        shopDomain,
        credentials: box.seal(credentials),
        statusMessage: `Connected to ${shop.name}`,
        createdBy: currentUserId(),
      })
      .returning();
    await this.events.audit('integration.connected', { type: 'integration', id: conn!.id }, { provider: 'shopify', shopDomain, method: credentials.kind ?? 'token' });
    return this.status();
  }

  async disconnect() {
    const conn = await this.requireConnection();
    await this.db.tx
      .update(schema.integrationConnections)
      .set({ status: 'disconnected', statusMessage: 'Disconnected' })
      .where(eq(schema.integrationConnections.id, conn.id));
    await this.events.audit('integration.disconnected', { type: 'integration', id: conn.id }, { provider: 'shopify' });
    return { connected: false };
  }

  async status() {
    const conn = await this.connection();
    if (!conn) return { connected: false as const, oauthEnabled: this.oauthEnabled };
    const [counts] = await this.db.tx.execute<{ products: string; variants: string; locations: string; issues: string }>(sql`
      select
        (select count(*) from external_mappings where connection_id = ${conn.id} and kind = 'product') as products,
        (select count(*) from external_mappings where connection_id = ${conn.id} and kind = 'variant') as variants,
        (select count(*) from external_mappings where connection_id = ${conn.id} and kind = 'location') as locations,
        (select count(*) from sync_issues where connection_id = ${conn.id} and resolved_at is null) as issues
    `);
    const { credentials: _hidden, ...publicFields } = conn;
    return {
      connected: true as const,
      ...publicFields,
      method: this.credentials(conn).kind === 'oauth' ? 'oauth' : 'token',
      webhookUrl: this.config.PUBLIC_API_URL ? `${this.config.PUBLIC_API_URL.replace(/\/+$/, '')}/webhooks/shopify/${conn.id}` : null,
      counts: { products: Number(counts?.products), variants: Number(counts?.variants), locations: Number(counts?.locations), openIssues: Number(counts?.issues) },
    };
  }

  async updateSettings(settings: { onlineOrdersLocationId: string | null }) {
    const conn = await this.requireConnection();
    if (settings.onlineOrdersLocationId) {
      const [loc] = await this.db.tx.select({ id: schema.locations.id }).from(schema.locations).where(eq(schema.locations.id, settings.onlineOrdersLocationId));
      if (!loc) throw new NotFoundException('Location not found');
    }
    await this.db.tx
      .update(schema.integrationConnections)
      .set({ settings: settings.onlineOrdersLocationId ? { onlineOrdersLocationId: settings.onlineOrdersLocationId } : {} })
      .where(eq(schema.integrationConnections.id, conn.id));
    return this.status();
  }

  // Locations ----------------------------------------------------------------

  async locations() {
    const conn = await this.requireConnection();
    const remote = await this.call(conn, (c) => c.locations());
    const mappings = await this.mappings(conn.id, 'location');
    return remote.map((l) => ({ ...l, locationId: mappings.get(l.id)?.internalId ?? null }));
  }

  /** Links a Shopify location to one of ours (or unlinks it with null). Stock is pushed only for linked pairs. */
  async mapLocation(shopifyLocationId: string, locationId: string | null) {
    const conn = await this.requireConnection();
    await this.db.tx
      .delete(schema.externalMappings)
      .where(and(eq(schema.externalMappings.connectionId, conn.id), eq(schema.externalMappings.kind, 'location'), eq(schema.externalMappings.externalId, shopifyLocationId)));
    if (locationId) {
      const [loc] = await this.db.tx.select({ id: schema.locations.id }).from(schema.locations).where(eq(schema.locations.id, locationId));
      if (!loc) throw new NotFoundException('Location not found');
      await this.db.tx
        .delete(schema.externalMappings)
        .where(and(eq(schema.externalMappings.connectionId, conn.id), eq(schema.externalMappings.kind, 'location'), eq(schema.externalMappings.internalId, locationId)));
      await this.db.tx.insert(schema.externalMappings).values({ tenantId: conn.tenantId, connectionId: conn.id, kind: 'location', externalId: shopifyLocationId, internalId: locationId });
    }
    return this.locations();
  }

  // Catalog (Shopify -> POS) -------------------------------------------------

  async importCatalog() {
    const conn = await this.requireConnection();
    const totals = { products: 0, created: 0, updated: 0, matched: 0, skipped: 0 };
    try {
      const client = await this.client(conn);
      for await (const product of client.products()) {
        const r = await this.upsertProduct(conn, product);
        totals.products++;
        totals.created += r.created;
        totals.updated += r.updated;
        totals.matched += r.matched;
        totals.skipped += r.skipped;
      }
    } catch (err) {
      throw this.asHttpError(err);
    }
    await this.db.tx.update(schema.integrationConnections).set({ lastImportAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    await this.events.audit('integration.catalog_imported', { type: 'integration', id: conn.id }, totals);
    return totals;
  }

  /** Webhook path: re-read one product from Shopify and apply it. */
  async importProduct(productId: string) {
    const conn = await this.requireConnection();
    const product = await this.call(conn, (c) => c.product(productId));
    if (product) await this.upsertProduct(conn, product);
  }

  private async upsertProduct(conn: Connection, product: ShopifyProduct) {
    const r = { created: 0, updated: 0, matched: 0, skipped: 0 };
    const tx = this.db.tx;
    const status = product.status === 'ACTIVE' ? 'active' : 'archived';
    const productMappings = await this.mappings(conn.id, 'product');
    const variantMappings = await this.mappings(conn.id, 'variant');

    // Where each Shopify variant should land: its mapped variant, or an unmapped one with the same SKU.
    const targets = new Map<string, { variantId: string; productId: string; matched: boolean }>();
    for (const v of product.variants) {
      const mapped = variantMappings.get(v.id);
      if (mapped) {
        const [pv] = await tx.select({ productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.id, mapped.internalId));
        if (pv) targets.set(v.id, { variantId: mapped.internalId, productId: pv.productId, matched: false });
        continue;
      }
      if (!v.sku) continue;
      const [bySku] = await tx
        .select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
        .from(schema.productVariants)
        .where(
          and(
            sql`lower(${schema.productVariants.sku}) = lower(${v.sku})`,
            sql`not exists (select 1 from external_mappings m where m.connection_id = ${conn.id} and m.kind = 'variant' and m.internal_id = ${schema.productVariants.id})`,
          ),
        );
      if (bySku) targets.set(v.id, { variantId: bySku.id, productId: bySku.productId, matched: true });
    }

    let productId = productMappings.get(product.id)?.internalId ?? [...targets.values()][0]?.productId ?? null;
    if (productId) {
      const [existing] = await tx.select().from(schema.products).where(eq(schema.products.id, productId));
      if (!existing) productId = null;
      else if (existing.name !== product.title || existing.status !== status || (existing.category ?? '') !== product.productType) {
        await tx
          .update(schema.products)
          .set({ name: product.title, status, category: product.productType || null, version: sql`${schema.products.version} + 1`, updatedAt: new Date() })
          .where(eq(schema.products.id, productId));
      }
    }
    if (!productId) {
      const [created] = await tx
        .insert(schema.products)
        .values({ tenantId: conn.tenantId, name: product.title, status, category: product.productType || null })
        .returning({ id: schema.products.id });
      productId = created!.id;
    }
    await this.setMapping(conn, 'product', product.id, productId);

    for (const [position, v] of product.variants.entries()) {
      const price = parseShopifyMoney(v.price);
      if (price === null) {
        await this.issue(conn, 'invalid_price', `${product.title} — ${v.title}: price "${v.price}" could not be read`, v.id);
        r.skipped++;
        continue;
      }
      const target = targets.get(v.id);
      // Never take a SKU another of our variants already uses.
      let sku = v.sku;
      if (sku) {
        const [clash] = await tx
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(and(sql`lower(${schema.productVariants.sku}) = lower(${sku})`, target ? ne(schema.productVariants.id, target.variantId) : undefined));
        if (clash) {
          await this.issue(conn, 'duplicate_sku', `${product.title} — ${v.title}: SKU ${sku} is already used by another item; imported without it`, v.id);
          sku = null;
        }
      }
      const fields = { name: variantName(v.title), sku, priceMinor: price, trackInventory: v.tracked, status: 'active' as const, position };
      let variantId: string;
      if (target) {
        await tx
          .update(schema.productVariants)
          .set({ ...fields, version: sql`${schema.productVariants.version} + 1`, updatedAt: new Date() })
          .where(eq(schema.productVariants.id, target.variantId));
        variantId = target.variantId;
        if (target.matched) r.matched++;
        else r.updated++;
      } else {
        const [created] = await tx
          .insert(schema.productVariants)
          .values({ tenantId: conn.tenantId, productId, ...fields })
          .returning({ id: schema.productVariants.id });
        variantId = created!.id;
        r.created++;
      }
      await this.setBarcodes(conn, variantId, v.barcodes, `${product.title} — ${v.title}`);
      await this.setMapping(conn, 'variant', v.id, variantId, { inventoryItemId: v.inventoryItemId });
    }

    // Variants removed from this product in Shopify stop being sold here too.
    const live = new Set(product.variants.map((v) => v.id));
    const gone: { ext: string; id: string }[] = [];
    for (const [ext, m] of variantMappings) {
      if (live.has(ext)) continue;
      const [pv] = await tx.select({ productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.id, m.internalId));
      if (pv?.productId === productId) gone.push({ ext, id: m.internalId });
    }
    if (gone.length) {
      await tx.update(schema.productVariants).set({ status: 'archived', updatedAt: new Date() }).where(inArray(schema.productVariants.id, gone.map((g) => g.id)));
      await tx
        .delete(schema.externalMappings)
        .where(and(eq(schema.externalMappings.connectionId, conn.id), eq(schema.externalMappings.kind, 'variant'), inArray(schema.externalMappings.externalId, gone.map((g) => g.ext))));
    }
    return r;
  }

  private async setBarcodes(conn: Connection, variantId: string, barcodes: string[], label: string) {
    const tx = this.db.tx;
    const wanted = [...new Set(barcodes.map((b) => b.trim()).filter((b) => /^[!-~]{1,64}$/.test(b)))];
    const taken = wanted.length
      ? await tx
          .select({ barcode: schema.variantBarcodes.barcode })
          .from(schema.variantBarcodes)
          .where(and(inArray(schema.variantBarcodes.barcode, wanted), ne(schema.variantBarcodes.variantId, variantId)))
      : [];
    for (const t of taken) await this.issue(conn, 'duplicate_barcode', `${label}: barcode ${t.barcode} is already used by another item`, t.barcode);
    const keep = wanted.filter((b) => !taken.some((t) => t.barcode === b));
    await tx.delete(schema.variantBarcodes).where(eq(schema.variantBarcodes.variantId, variantId));
    if (keep.length) await tx.insert(schema.variantBarcodes).values(keep.map((barcode) => ({ tenantId: conn.tenantId, variantId, barcode })));
  }

  // Stock (POS -> Shopify) ---------------------------------------------------

  /**
   * Sets Shopify's "available" quantity to our on-hand quantity for every
   * linked variant and location (or only `variantIds`). Uses compare-and-swap
   * against the value we last pushed: if Shopify changed meanwhile (usually an
   * online order we haven't recorded yet) the push is skipped and counted as a
   * conflict, and the next attempt uses Shopify's current value.
   *
   * The first time an item is seen at a location we have no stock record for
   * (typically right after connecting), Shopify's quantity is adopted as our
   * starting stock rather than overwritten with zero.
   */
  async pushInventory(variantIds?: string[]): Promise<PushResult> {
    const conn = await this.connection();
    const result: PushResult = { seeded: 0, pushed: 0, unchanged: 0, conflicts: 0, failed: 0 };
    // Without the Inventory tool we have no stock to speak for; never push zeros.
    if (!conn || conn.status !== 'active' || !(await this.inventoryEnabled())) return result;
    const client = await this.client(conn);
    const tx = this.db.tx;

    const pairs = await tx.execute<{ variant_id: string; inventory_item_id: string; location_id: string; shopify_location_id: string; on_hand: number | null }>(sql`
      select v.internal_id as variant_id, v.data->>'inventoryItemId' as inventory_item_id,
             l.internal_id as location_id, l.external_id as shopify_location_id, s.on_hand
      from external_mappings v
      join product_variants pv on pv.id = v.internal_id and pv.track_inventory
      cross join external_mappings l
      left join stock_levels s on s.variant_id = v.internal_id and s.location_id = l.internal_id
      where v.connection_id = ${conn.id} and v.kind = 'variant'
        and l.connection_id = ${conn.id} and l.kind = 'location'
        and v.data ? 'inventoryItemId'
        ${variantIds?.length ? sql`and v.internal_id in (${sql.join(variantIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
    `);

    for (const p of pairs) {
      const desired = Math.max(0, Number(p.on_hand ?? 0));
      await tx
        .insert(schema.inventoryPushState)
        .values({ tenantId: conn.tenantId, connectionId: conn.id, variantId: p.variant_id, locationId: p.location_id })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(schema.inventoryPushState)
        .where(
          and(
            eq(schema.inventoryPushState.connectionId, conn.id),
            eq(schema.inventoryPushState.variantId, p.variant_id),
            eq(schema.inventoryPushState.locationId, p.location_id),
          ),
        )
        .for('update');
      if (state!.lastPushed === null && p.on_hand === null) {
        await this.seedFromShopify(conn, client, p, result);
        continue;
      }
      if (state!.lastPushed === desired) {
        result.unchanged++;
        continue;
      }
      try {
        const changeFrom = state!.lastPushed ?? (await client.available(p.inventory_item_id, p.shopify_location_id));
        if (changeFrom === desired) {
          await this.savePushState(conn, p, desired, state!.pushSeq + 1);
          result.unchanged++;
          continue;
        }
        // Same change retried → same key; a new change → new key (seq or values differ).
        const key = createHash('sha256').update(`${conn.id}:${p.variant_id}:${p.location_id}:${state!.pushSeq}:${changeFrom}:${desired}`).digest('hex').slice(0, 32);
        const errors = await client.setAvailable(
          [{ inventoryItemId: p.inventory_item_id, locationId: p.shopify_location_id, quantity: desired, changeFromQuantity: changeFrom }],
          key,
          `ample-pos://stock/${p.location_id}/${p.variant_id}`,
        );
        if (!errors.length) {
          await this.savePushState(conn, p, desired, state!.pushSeq + 1);
          result.pushed++;
        } else if (errors.some((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE' || e.code === 'COMPARE_QUANTITY_STALE')) {
          // Remember what Shopify has now, so the retry compares against it.
          const current = await client.available(p.inventory_item_id, p.shopify_location_id);
          await this.savePushState(conn, p, current, state!.pushSeq);
          result.conflicts++;
        } else {
          await this.issue(conn, 'push_failed', `Could not set stock in Shopify: ${errors.map((e) => e.message).join('; ')}`, p.inventory_item_id);
          result.failed++;
        }
      } catch (err) {
        if (err instanceof ShopifyError && err.retryable) throw err;
        await this.issue(conn, 'push_failed', `Could not set stock in Shopify: ${(err as Error).message}`, p.inventory_item_id);
        result.failed++;
      }
    }
    if (result.pushed) await tx.update(schema.integrationConnections).set({ lastPushAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    return result;
  }

  private async seedFromShopify(
    conn: Connection,
    client: ShopifyClient,
    p: { variant_id: string; location_id: string; inventory_item_id: string; shopify_location_id: string },
    result: PushResult,
  ) {
    const current = await client.available(p.inventory_item_id, p.shopify_location_id);
    if (current === null) return; // Not stocked at that Shopify location.
    if (current > 0) {
      await this.ledger.record({
        kind: 'adjustment',
        idempotencyKey: `shopify:${conn.id}:seed:${p.variant_id}:${p.location_id}`,
        note: 'Starting stock from Shopify',
        lines: [{ locationId: p.location_id, variantId: p.variant_id, quantityDelta: current, reason: 'adjustment' }],
      });
    }
    await this.savePushState(conn, p, current, 1);
    result.seeded++;
  }

  private async inventoryEnabled(): Promise<boolean> {
    const [row] = await this.db.tx.select({ enabled: schema.tenantModules.enabled }).from(schema.tenantModules).where(eq(schema.tenantModules.moduleId, 'inventory'));
    return row?.enabled ?? false;
  }

  private async savePushState(conn: Connection, p: { variant_id: string; location_id: string }, quantity: number | null, pushSeq: number) {
    await this.db.tx
      .update(schema.inventoryPushState)
      .set({ lastPushed: quantity, pushSeq, lastPushedAt: new Date() })
      .where(
        and(
          eq(schema.inventoryPushState.connectionId, conn.id),
          eq(schema.inventoryPushState.variantId, p.variant_id),
          eq(schema.inventoryPushState.locationId, p.location_id),
        ),
      );
  }

  // Online orders (Shopify -> POS stock) -------------------------------------

  async ingestOrder(orderId: string) {
    const conn = await this.requireConnection();
    const order = await this.call(conn, (c) => c.order(orderId));
    if (order) await this.applyOrder(conn, order);
  }

  /**
   * Records an online order as sale movements at the online-orders location,
   * and a cancellation as returns. Both are keyed by the order id, so repeated
   * webhooks or reconciliation never count an order twice.
   */
  private async applyOrder(conn: Connection, order: ShopifyOrder) {
    if (!(await this.inventoryEnabled())) return;
    const locationId = conn.settings.onlineOrdersLocationId;
    if (!locationId) {
      await this.issue(conn, 'orders_location_missing', `Online order ${order.name} was not recorded: choose which location fulfils online orders`, order.id);
      return;
    }
    const variantMappings = await this.mappings(conn.id, 'variant');
    const quantities = new Map<string, number>();
    const unmapped: string[] = [];
    for (const line of order.lines) {
      const mapped = line.variantId ? variantMappings.get(line.variantId) : undefined;
      if (!mapped) {
        if (line.variantId) unmapped.push(line.variantId);
        continue;
      }
      quantities.set(mapped.internalId, (quantities.get(mapped.internalId) ?? 0) + line.quantity);
    }
    if (unmapped.length) await this.issue(conn, 'unmapped_item', `Online order ${order.name} has items that aren't imported yet; import products to include them`, order.id);

    const tracked = quantities.size
      ? await this.db.tx
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(and(inArray(schema.productVariants.id, [...quantities.keys()]), eq(schema.productVariants.trackInventory, true)))
      : [];
    const lines = tracked.map((t) => ({ variantId: t.id, quantity: quantities.get(t.id)! })).filter((l) => l.quantity > 0);
    if (!lines.length) return;

    const saleKey = `shopify:${conn.id}:order:${order.id}`;
    const [alreadySold] = await this.db.tx.select({ id: schema.inventoryOperations.id }).from(schema.inventoryOperations).where(eq(schema.inventoryOperations.idempotencyKey, saleKey));
    // An order we first see already cancelled never took stock.
    if (order.cancelledAt && !alreadySold) return;

    const changed: { variantId: string; quantityDelta: number }[] = [];
    if (!alreadySold) {
      await this.ledger.record({
        kind: 'sale',
        idempotencyKey: saleKey,
        note: `Online order ${order.name}`,
        reference: { type: 'shopify_order', id: order.id },
        lines: lines.map((l) => ({ locationId, variantId: l.variantId, quantityDelta: -l.quantity, reason: 'sale' })),
      });
      changed.push(...lines.map((l) => ({ variantId: l.variantId, quantityDelta: -l.quantity })));
    }
    if (order.cancelledAt) {
      const result = await this.ledger.record({
        kind: 'refund',
        idempotencyKey: `shopify:${conn.id}:order-cancel:${order.id}`,
        note: `Online order ${order.name} cancelled`,
        reference: { type: 'shopify_order', id: order.id },
        lines: lines.map((l) => ({ locationId, variantId: l.variantId, quantityDelta: l.quantity, reason: 'return' })),
      });
      if (!result.replayed) changed.push(...lines.map((l) => ({ variantId: l.variantId, quantityDelta: l.quantity })));
    }
    if (changed.length) {
      // Shopify already moved its own stock for this order at the location linked
      // to the online-orders location. Shift our record of what we last pushed by
      // the same amount, so the follow-up push doesn't see a false conflict. If
      // Shopify used another location, compare-and-swap still catches it.
      for (const c of changed) {
        await this.db.tx
          .update(schema.inventoryPushState)
          .set({ lastPushed: sql`${schema.inventoryPushState.lastPushed} + ${c.quantityDelta}` })
          .where(
            and(
              eq(schema.inventoryPushState.connectionId, conn.id),
              eq(schema.inventoryPushState.variantId, c.variantId),
              eq(schema.inventoryPushState.locationId, locationId),
              sql`${schema.inventoryPushState.lastPushed} is not null`,
            ),
          );
      }
      await this.events.record('inventory.online_order', { type: 'operation', id: order.id }, {
        orderName: order.name,
        locationId,
        lines: changed.map((c) => ({ locationId, ...c })),
      });
    }
  }

  // Reconciliation -----------------------------------------------------------

  /**
   * Catches up on anything webhooks missed: orders updated since the last
   * check are applied (idempotently), then every linked item's stock is pushed.
   */
  async reconcile() {
    const conn = await this.requireConnection();
    const startedAt = new Date();
    const since = conn.ordersCheckedAt ?? new Date(startedAt.getTime() - 24 * 3600_000);
    let orders = 0;
    try {
      for await (const order of (await this.client(conn)).ordersUpdatedSince(new Date(since.getTime() - 60_000))) {
        await this.applyOrder(conn, order);
        orders++;
      }
    } catch (err) {
      throw this.asHttpError(err);
    }
    await this.db.tx.update(schema.integrationConnections).set({ ordersCheckedAt: startedAt }).where(eq(schema.integrationConnections.id, conn.id));
    const stock = await this.pushInventory().catch((err) => {
      throw this.asHttpError(err);
    });
    return { orders, stock };
  }

  async registerWebhooks() {
    const conn = await this.requireConnection();
    const status = await this.status();
    if (!status.connected || !status.webhookUrl) throw new BadRequestException('Set PUBLIC_API_URL so Shopify can reach this server');
    const results = [];
    for (const topic of WEBHOOK_TOPICS) {
      const errors = await this.call(conn, (c) => c.createWebhook(topic, status.webhookUrl!));
      // "already taken" means the subscription exists, which is what we want.
      const real = errors.filter((e) => !/taken|already exists/i.test(e.message));
      results.push({ topic, ok: real.length === 0, error: real.map((e) => e.message).join('; ') || null });
    }
    return results;
  }

  // Issues -------------------------------------------------------------------

  async issues() {
    const conn = await this.requireConnection();
    return this.db.tx
      .select()
      .from(schema.syncIssues)
      .where(and(eq(schema.syncIssues.connectionId, conn.id), isNull(schema.syncIssues.resolvedAt)))
      .orderBy(sql`${schema.syncIssues.id} desc`)
      .limit(100);
  }

  async resolveIssue(id: number) {
    const [row] = await this.db.tx
      .update(schema.syncIssues)
      .set({ resolvedAt: new Date() })
      .where(and(eq(schema.syncIssues.id, id), isNull(schema.syncIssues.resolvedAt)))
      .returning({ id: schema.syncIssues.id });
    if (!row) throw new NotFoundException('Issue not found');
    return { id, resolved: true };
  }

  /** Records a problem for the sync dashboard, once per kind and reference while it stays open. */
  private async issue(conn: Connection, kind: string, message: string, externalRef: string | null) {
    const [open] = await this.db.tx
      .select({ id: schema.syncIssues.id })
      .from(schema.syncIssues)
      .where(
        and(
          eq(schema.syncIssues.connectionId, conn.id),
          eq(schema.syncIssues.kind, kind),
          externalRef ? eq(schema.syncIssues.externalRef, externalRef) : isNull(schema.syncIssues.externalRef),
          isNull(schema.syncIssues.resolvedAt),
        ),
      );
    if (open) return;
    this.logger.warn(`${kind}: ${message}`);
    await this.db.tx.insert(schema.syncIssues).values({ tenantId: conn.tenantId, connectionId: conn.id, kind, message, externalRef });
  }

  // Helpers ------------------------------------------------------------------

  async markUninstalled() {
    const conn = await this.connection();
    if (!conn) return;
    await this.db.tx
      .update(schema.integrationConnections)
      .set({ status: 'error', statusMessage: 'The app was uninstalled from Shopify. Reconnect to resume syncing.' })
      .where(eq(schema.integrationConnections.id, conn.id));
  }

  credentials(conn: Connection): Credentials {
    return this.box().open<Credentials>(conn.credentials);
  }

  /** The secret Shopify signs this connection's webhooks with. */
  webhookSecret(conn: Connection): string {
    const creds = this.credentials(conn);
    return creds.kind === 'oauth' ? this.config.SHOPIFY_CLIENT_SECRET! : creds.webhookSecret;
  }

  private async client(conn: Connection): Promise<ShopifyClient> {
    let creds = this.credentials(conn);
    if (creds.kind === 'oauth' && Date.parse(creds.expiresAt) - REFRESH_MARGIN_MS < Date.now()) creds = await this.refresh(conn);
    return new ShopifyClient(conn.shopDomain, creds.accessToken, this.fetchImpl);
  }

  /**
   * Renews an expiring token in its own short transaction, committed whatever
   * happens to the request around it: Shopify rotates the refresh token, so the
   * new one must be kept, and a refusal (app uninstalled, refresh token unused
   * for 90 days) must stay recorded as "reconnect needed". The row lock stops
   * two workers spending the same refresh token; SKIP LOCKED means we never
   * wait on a lock (including one held by the calling transaction).
   */
  private async refresh(conn: Connection): Promise<Credentials> {
    const outcome = await this.db.pool.transaction(async (rtx) => {
      await rtx.execute(sql`select set_config('app.tenant_id', ${conn.tenantId}, true)`);
      const [locked] = await rtx
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, conn.id))
        .for('update', { skipLocked: true });
      if (!locked) return { creds: this.credentials(conn) }; // someone else is refreshing; use what we have
      const creds = this.credentials(locked);
      if (creds.kind !== 'oauth' || Date.parse(creds.expiresAt) - REFRESH_MARGIN_MS > Date.now()) return { creds };
      try {
        const tokens = await refreshTokens(this.fetchImpl, {
          shop: conn.shopDomain,
          clientId: this.config.SHOPIFY_CLIENT_ID!,
          clientSecret: this.config.SHOPIFY_CLIENT_SECRET!,
          refreshToken: creds.refreshToken,
        });
        const next: Credentials = { kind: 'oauth', ...tokens };
        const sealed = this.box().seal(next);
        await rtx.update(schema.integrationConnections).set({ credentials: sealed }).where(eq(schema.integrationConnections.id, conn.id));
        conn.credentials = sealed;
        return { creds: next };
      } catch (err) {
        if (err instanceof ShopifyError && !err.retryable) {
          await rtx
            .update(schema.integrationConnections)
            .set({ status: 'error', statusMessage: 'Shopify access expired or was revoked. Reconnect the store.' })
            .where(eq(schema.integrationConnections.id, conn.id));
        }
        return { error: err };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.creds;
  }

  private async call<T>(conn: Connection, fn: (c: ShopifyClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.client(conn));
    } catch (err) {
      throw this.asHttpError(err);
    }
  }

  /** Inside a request: turn Shopify failures into a clear HTTP error. Background work rethrows to retry. */
  private asHttpError(err: unknown): unknown {
    if (err instanceof ShopifyError) {
      return err.retryable ? new ServiceUnavailableException(`Shopify is unavailable: ${err.message}`) : new BadRequestException(`Shopify: ${err.message}`);
    }
    return err;
  }

  private box(): SecretBox {
    if (!this.secrets) throw new ServiceUnavailableException('Integrations are disabled: set SECRETS_KEY on the server');
    return this.secrets;
  }

  private async mappings(connectionId: string, kind: 'product' | 'variant' | 'location') {
    const rows = await this.db.tx
      .select()
      .from(schema.externalMappings)
      .where(and(eq(schema.externalMappings.connectionId, connectionId), eq(schema.externalMappings.kind, kind)));
    return new Map(rows.map((r) => [r.externalId, r]));
  }

  private async setMapping(conn: Connection, kind: 'product' | 'variant', externalId: string, internalId: string, data: Record<string, string> = {}) {
    // One-to-one: drop any other mapping pointing at the same internal record first.
    await this.db.tx
      .delete(schema.externalMappings)
      .where(
        and(
          eq(schema.externalMappings.connectionId, conn.id),
          eq(schema.externalMappings.kind, kind),
          eq(schema.externalMappings.internalId, internalId),
          ne(schema.externalMappings.externalId, externalId),
        ),
      );
    await this.db.tx
      .insert(schema.externalMappings)
      .values({ tenantId: conn.tenantId, connectionId: conn.id, kind, externalId, internalId, data })
      .onConflictDoUpdate({
        target: [schema.externalMappings.connectionId, schema.externalMappings.kind, schema.externalMappings.externalId],
        set: { internalId, data, updatedAt: new Date() },
      });
  }
}

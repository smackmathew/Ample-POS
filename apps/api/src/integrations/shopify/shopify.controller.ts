import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { Db } from '../../core/database';
import { Public, RequireModule, RequirePermission } from '../../core/decorators';
import { Events } from '../../core/events';
import { runAsSystem } from '../../core/system-context';
import { ZodPipe } from '../../core/zod';
import { SHOP_DOMAIN } from './oauth';
import { ShopifySyncService } from './shopify-sync.service';

const connectBody = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .refine((d) => SHOP_DOMAIN.test(d), 'use the store’s .myshopify.com address'),
  accessToken: z.string().trim().min(10).max(200),
  webhookSecret: z.string().trim().min(10).max(200),
});
const oauthStartBody = z.object({ shopDomain: connectBody.shape.shopDomain });
const oauthCompleteBody = z.object({
  /** The query parameters Shopify redirected back with. */
  params: z.record(z.string().max(2000)),
  /** The nonce the web app kept in a cookie when the flow started. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
});
const mapLocationBody = z.object({ locationId: z.string().uuid().nullable() });
const settingsBody = z.object({ onlineOrdersLocationId: z.string().uuid().nullable() });

@Controller('integrations/shopify')
@RequireModule('ecommerce-sync')
@RequirePermission('sync.manage')
export class ShopifyController {
  constructor(private readonly sync: ShopifySyncService) {}

  @Get()
  status() {
    return this.sync.status();
  }

  @Post('connect')
  connect(@Body(new ZodPipe(connectBody)) body: z.infer<typeof connectBody>) {
    return this.sync.connect(body);
  }

  /** Starts "Connect with Shopify": returns Shopify's approval URL and the nonce to keep in a cookie. */
  @Post('oauth/start')
  startOAuth(@Body(new ZodPipe(oauthStartBody)) body: z.infer<typeof oauthStartBody>) {
    return this.sync.startOAuth(body.shopDomain);
  }

  @Post('oauth/complete')
  completeOAuth(@Body(new ZodPipe(oauthCompleteBody)) body: z.infer<typeof oauthCompleteBody>) {
    return this.sync.completeOAuth(body.params, body.nonce);
  }

  @Delete()
  disconnect() {
    return this.sync.disconnect();
  }

  @Put('settings')
  settings(@Body(new ZodPipe(settingsBody)) body: z.infer<typeof settingsBody>) {
    return this.sync.updateSettings(body);
  }

  @Get('locations')
  locations() {
    return this.sync.locations();
  }

  @Put('locations/:shopifyLocationId')
  mapLocation(@Param('shopifyLocationId') id: string, @Body(new ZodPipe(mapLocationBody)) body: z.infer<typeof mapLocationBody>) {
    return this.sync.mapLocation(decodeURIComponent(id), body.locationId);
  }

  @Post('import')
  importCatalog() {
    return this.sync.importCatalog();
  }

  @Post('push')
  push() {
    return this.sync.pushInventory();
  }

  @Post('reconcile')
  reconcile() {
    return this.sync.reconcile();
  }

  @Post('webhooks')
  registerWebhooks() {
    return this.sync.registerWebhooks();
  }

  @Get('issues')
  issues() {
    return this.sync.issues();
  }

  @Post('issues/:id/resolve')
  resolve(@Param('id', ParseIntPipe) id: number) {
    return this.sync.resolveIssue(id);
  }
}

/**
 * Shopify webhooks. The URL names the connection; the body is verified with
 * that connection's secret, de-duplicated by webhook id, and queued for the
 * worker, which re-reads the resource from Shopify instead of trusting the body.
 */
@Controller('webhooks/shopify')
export class ShopifyWebhookController {
  private readonly logger = new Logger('ShopifyWebhook');

  constructor(
    private readonly db: Db,
    private readonly sync: ShopifySyncService,
    private readonly events: Events,
  ) {}

  @Public()
  @Post(':connectionId')
  @HttpCode(200)
  async receive(@Param('connectionId', ParseUUIDPipe) connectionId: string, @Req() req: RawBodyRequest<Request>) {
    const [row] = await this.db.pool.execute<{ tenant_id: string | null }>(sql`select app_connection_tenant(${connectionId}::uuid) as tenant_id`);
    if (!row?.tenant_id) throw new NotFoundException();
    const raw = req.rawBody ?? Buffer.alloc(0);
    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };

    return runAsSystem(this.db, row.tenant_id, async () => {
      const conn = await this.sync.connection();
      if (!conn || conn.id !== connectionId) throw new NotFoundException();
      const expected = createHmac('sha256', this.sync.webhookSecret(conn)).update(raw).digest();
      const given = Buffer.from(header('x-shopify-hmac-sha256') ?? '', 'base64');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('Invalid webhook signature');

      const webhookId = header('x-shopify-webhook-id') ?? header('x-shopify-event-id');
      if (webhookId) {
        const inserted = await this.db.tx
          .insert(schema.processedWebhooks)
          .values({ tenantId: conn.tenantId, connectionId: conn.id, webhookId })
          .onConflictDoNothing()
          .returning({ id: schema.processedWebhooks.webhookId });
        if (!inserted.length) return { received: true, duplicate: true };
      }

      let body: { admin_graphql_api_id?: unknown } = {};
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        this.logger.warn(`Unparseable webhook body for ${conn.id}`);
      }
      const topic = header('x-shopify-topic') ?? 'unknown';
      await this.events.emit('shopify.webhook', {
        connectionId: conn.id,
        topic,
        resourceId: typeof body.admin_graphql_api_id === 'string' ? body.admin_graphql_api_id : null,
      });
      return { received: true };
    });
  }
}

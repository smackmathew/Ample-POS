import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isPublicEvent, TEST_EVENT, type WebhookBody } from '../core/api-events';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { actorUserId, currentTenant } from '../core/request-context';
import { SECRET_BOX, type SecretBox } from '../core/secrets';
import { ZodPipe } from '../core/zod';
import { newWebhookSecret, sealWebhookSecret } from './webhook-secret';

const url = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
  }, 'Use an https:// address');

const events = z
  .array(z.string().trim())
  .min(1)
  .max(50)
  .refine((list) => list.every((t) => t === '*' || isPublicEvent(t)), 'Unknown event type; see GET /events/types');

const createBody = z.object({ url, events, description: z.string().trim().max(200).optional() });
const updateBody = z.object({ url: url.optional(), events: events.optional(), description: z.string().trim().max(200).nullable().optional(), active: z.boolean().optional() });
const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

/**
 * Webhooks: Ample POS POSTs each event to the business's URLs, signed with the
 * endpoint's secret. Another app with an API key holding api.manage can
 * register its own endpoint.
 */
@Controller('webhooks')
@RequirePermission('api.manage')
export class WebhookEndpointsController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    @Inject(SECRET_BOX) private readonly box: SecretBox | null,
  ) {}

  @Get()
  async list() {
    const w = schema.webhookEndpoints;
    return this.db.tx
      .select({
        id: w.id,
        url: w.url,
        description: w.description,
        events: w.events,
        active: w.active,
        createdAt: w.createdAt,
        pending: sql<number>`(select count(*) from webhook_deliveries d where d.endpoint_id = webhook_endpoints.id and d.status = 'pending')`.mapWith(Number),
        failed: sql<number>`(select count(*) from webhook_deliveries d where d.endpoint_id = webhook_endpoints.id and d.status = 'failed' and d.created_at > now() - interval '7 days')`.mapWith(Number),
        lastDeliveredAt: sql<string | null>`(select max(delivered_at) from webhook_deliveries d where d.endpoint_id = webhook_endpoints.id)`,
      })
      .from(w)
      .orderBy(desc(w.createdAt));
  }

  /** Returns the signing secret once. */
  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const secret = newWebhookSecret();
    const [endpoint] = await this.db.tx
      .insert(schema.webhookEndpoints)
      .values({
        tenantId: currentTenant().tenantId,
        url: body.url,
        description: body.description ?? null,
        events: normalize(body.events),
        secret: sealWebhookSecret(this.box, secret),
        createdBy: actorUserId(),
      })
      .returning({ id: schema.webhookEndpoints.id, url: schema.webhookEndpoints.url, events: schema.webhookEndpoints.events });
    await this.events.audit('webhook.created', { type: 'webhook', id: endpoint!.id }, { url: body.url, events: endpoint!.events });
    return { ...endpoint, secret };
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const { events: types, ...rest } = body;
    const [endpoint] = await this.db.tx
      .update(schema.webhookEndpoints)
      .set({ ...rest, ...(types ? { events: normalize(types) } : {}), updatedAt: new Date() })
      .where(eq(schema.webhookEndpoints.id, id))
      .returning({ id: schema.webhookEndpoints.id, url: schema.webhookEndpoints.url, events: schema.webhookEndpoints.events, active: schema.webhookEndpoints.active });
    if (!endpoint) throw new NotFoundException('Webhook not found');
    await this.events.audit('webhook.updated', { type: 'webhook', id }, body);
    return endpoint;
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const [gone] = await this.db.tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id)).returning({ url: schema.webhookEndpoints.url });
    if (!gone) throw new NotFoundException('Webhook not found');
    await this.events.audit('webhook.deleted', { type: 'webhook', id }, { url: gone.url });
    return { deleted: true };
  }

  /** A new signing secret; the old one stops working at once. */
  @Post(':id/rotate-secret')
  @HttpCode(200)
  async rotate(@Param('id', ParseUUIDPipe) id: string) {
    const secret = newWebhookSecret();
    const [row] = await this.db.tx
      .update(schema.webhookEndpoints)
      .set({ secret: sealWebhookSecret(this.box, secret), updatedAt: new Date() })
      .where(eq(schema.webhookEndpoints.id, id))
      .returning({ id: schema.webhookEndpoints.id });
    if (!row) throw new NotFoundException('Webhook not found');
    await this.events.audit('webhook.secret_rotated', { type: 'webhook', id });
    return { secret };
  }

  /** Queues a webhook.test event so you can check your endpoint and signature check. */
  @Post(':id/test')
  @HttpCode(200)
  async test(@Param('id', ParseUUIDPipe) id: string) {
    const [endpoint] = await this.db.tx.select({ id: schema.webhookEndpoints.id }).from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
    if (!endpoint) throw new NotFoundException('Webhook not found');
    const { tenantId } = currentTenant();
    const body: WebhookBody = { id: `evt_test_${Date.now()}`, type: TEST_EVENT, createdAt: new Date().toISOString(), businessId: tenantId, data: { message: 'Hello from Ample POS' } };
    const [delivery] = await this.db.tx
      .insert(schema.webhookDeliveries)
      .values({ tenantId, endpointId: id, type: TEST_EVENT, body: body as unknown as Record<string, unknown> })
      .returning({ id: schema.webhookDeliveries.id });
    return { queued: true, deliveryId: delivery!.id };
  }

  @Get(':id/deliveries')
  async deliveries(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(deliveriesQuery)) q: z.infer<typeof deliveriesQuery>) {
    const d = schema.webhookDeliveries;
    return this.db.tx
      .select({
        id: d.id,
        type: d.type,
        eventId: sql<string>`${d.body} ->> 'id'`,
        status: d.status,
        attempts: d.attempts,
        responseStatus: d.responseStatus,
        lastError: d.lastError,
        nextAttemptAt: d.nextAttemptAt,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
      })
      .from(d)
      .where(eq(d.endpointId, id))
      .orderBy(desc(d.id))
      .limit(q.limit);
  }

  /** Sends a failed (or pending) delivery again now. */
  @Post('deliveries/:deliveryId/retry')
  @HttpCode(200)
  async retry(@Param('deliveryId', ParseIntPipe) deliveryId: number) {
    const d = schema.webhookDeliveries;
    const [row] = await this.db.tx
      .update(d)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(and(eq(d.id, deliveryId), sql`${d.status} <> 'delivered'`))
      .returning({ id: d.id });
    if (!row) throw new BadRequestException('Delivery not found, or it was already delivered');
    return { queued: true };
  }
}

/** '*' wins over a list. */
function normalize(types: string[]): string[] {
  return types.includes('*') ? ['*'] : [...new Set(types)];
}

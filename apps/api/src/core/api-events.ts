import { Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission } from '@pos/modules';
import { and, eq, sql } from 'drizzle-orm';
import { currentContext, currentTenant } from './request-context';

/**
 * Events other apps can follow, through the change feed (GET /events) and
 * webhooks. Each needs a permission to read, so a key limited to the catalog
 * doesn't see sales.
 */
export const PUBLIC_EVENTS: Record<string, { permission: string | null; description: string }> = {
  'product.created': { permission: 'catalog.read', description: 'A product was added' },
  'product.updated': { permission: 'catalog.read', description: 'A product’s name, description, category or status changed' },
  'variant.created': { permission: 'catalog.read', description: 'A variant (size, color...) was added to a product' },
  'variant.updated': { permission: 'catalog.read', description: 'A variant’s price, SKU, barcodes or status changed' },
  'inventory.changed': { permission: 'inventory.read', description: 'Stock went up or down at a location (sale, delivery, count, adjustment, transfer)' },
  'sale.completed': { permission: 'pos.sell', description: 'A sale was paid in full' },
  'sale.refunded': { permission: 'pos.sell', description: 'Some or all of a sale was refunded' },
  'sale.voided': { permission: 'pos.sell', description: 'An unpaid sale was voided' },
  'customer.created': { permission: 'customers.use', description: 'A customer was added' },
  'customer.updated': { permission: 'customers.use', description: 'A customer’s details changed' },
  'customer.deleted': { permission: 'customers.use', description: 'A customer was deleted' },
  'purchase_order.ordered': { permission: 'purchasing.receive', description: 'A purchase order was sent to the supplier' },
  'purchase_order.received': { permission: 'purchasing.receive', description: 'A delivery was received against a purchase order' },
  'location.created': { permission: null, description: 'A location was added' },
  'location.updated': { permission: null, description: 'A location was changed or archived' },
};

/** Sent only by "Send test event"; not part of the feed. */
export const TEST_EVENT = 'webhook.test';

export function isPublicEvent(type: string): boolean {
  return type in PUBLIC_EVENTS;
}

/** The event types these permissions may read. */
export function readableEvents(permissions: readonly string[]): string[] {
  return Object.entries(PUBLIC_EVENTS)
    .filter(([, e]) => !e.permission || hasPermission(permissions, e.permission))
    .map(([type]) => type);
}

export interface WebhookBody {
  id: string;
  type: string;
  createdAt: string;
  businessId: string;
  data: Record<string, unknown>;
}

@Injectable()
export class ApiEvents {
  /**
   * Adds the event to the business's change feed and queues it for every
   * webhook that wants it, in the current transaction: if the change rolls
   * back, so does the event.
   */
  async publish(type: string, data: Record<string, unknown>): Promise<void> {
    if (!isPublicEvent(type)) return;
    const { tx } = currentContext();
    const { tenantId } = currentTenant();
    const [event] = await tx.insert(schema.apiEvents).values({ tenantId, type, data }).returning();
    const endpoints = await tx
      .select({ id: schema.webhookEndpoints.id })
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.active, true), sql`${schema.webhookEndpoints.events} && array['*', ${type}]::text[]`));
    if (!endpoints.length) return;
    const body: WebhookBody = { id: `evt_${event!.id}`, type, createdAt: event!.createdAt.toISOString(), businessId: tenantId, data };
    await tx
      .insert(schema.webhookDeliveries)
      .values(endpoints.map((e) => ({ tenantId, endpointId: e.id, eventId: event!.id, type, body: body as unknown as Record<string, unknown> })));
  }
}

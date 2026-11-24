import { Controller, Get, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, asc, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PUBLIC_EVENTS, readableEvents } from '../core/api-events';
import { Db } from '../core/database';
import { Public } from '../core/decorators';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const feedQuery = z.object({
  /** The last event id you've handled; 0 (or nothing) starts from the beginning. */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Comma-separated event types, e.g. inventory.changed,sale.completed */
  types: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => (v ? v.split(',').map((t) => t.trim()).filter(Boolean) : undefined)),
});

/**
 * The change feed: every public event for the business, oldest first. Poll it
 * with the last id you handled to catch up, e.g. after downtime or alongside
 * webhooks. Only event types the caller may read are included.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly db: Db) {}

  @Get()
  async feed(@Query(new ZodPipe(feedQuery)) q: z.infer<typeof feedQuery>) {
    const readable = readableEvents(currentTenant().permissions);
    const types = q.types ? q.types.filter((t) => readable.includes(t)) : readable;
    const e = schema.apiEvents;
    const rows = types.length
      ? await this.db.tx
          .select({ id: e.id, type: e.type, data: e.data, createdAt: e.createdAt })
          .from(e)
          .where(and(gt(e.id, q.after), inArray(e.type, types)))
          .orderBy(asc(e.id))
          .limit(q.limit + 1)
      : [];
    const page = rows.slice(0, q.limit);
    return {
      events: page,
      /** Pass this as `after` next time. */
      next: page.length ? page[page.length - 1]!.id : q.after,
      hasMore: rows.length > q.limit,
    };
  }

  /** Every event type, for the public API guide. */
  @Public()
  @Get('catalog')
  catalog() {
    return Object.entries(PUBLIC_EVENTS).map(([type, e]) => ({ type, description: e.description, permission: e.permission }));
  }

  /** Every event type, and whether this caller can see it. */
  @Get('types')
  types() {
    const readable = new Set(readableEvents(currentTenant().permissions));
    return Object.entries(PUBLIC_EVENTS).map(([type, e]) => ({ type, description: e.description, permission: e.permission, readable: readable.has(type) }));
  }
}

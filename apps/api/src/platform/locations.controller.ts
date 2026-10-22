import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezone = z.string().refine(isTimeZone, 'must be an IANA time zone, e.g. America/Chicago');
const kind = z.enum(['store', 'warehouse', 'office']);

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: kind.default('store'),
  timezone,
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind,
    timezone,
    archived: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'provide at least one field');

@Controller('locations')
export class LocationsController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    const query = this.db.tx.select().from(schema.locations).orderBy(asc(schema.locations.name));
    return includeArchived === 'true' ? query : query.where(isNull(schema.locations.archivedAt));
  }

  @RequirePermission('locations.manage')
  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const [location] = await this.db.tx
      .insert(schema.locations)
      .values({ tenantId: currentTenant().tenantId, ...body })
      .returning();
    await this.events.record('location.created', { type: 'location', id: location!.id }, body);
    return location;
  }

  @RequirePermission('locations.manage')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const { archived, ...fields } = body;
    const [location] = await this.db.tx
      .update(schema.locations)
      .set({ ...fields, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) })
      .where(eq(schema.locations.id, id))
      .returning();
    if (!location) throw new NotFoundException('Location not found');
    await this.events.record('location.updated', { type: 'location', id }, body);
    return location;
  }
}

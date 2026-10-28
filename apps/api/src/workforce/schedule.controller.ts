import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission } from '@pos/modules';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const uuid = z.string().uuid();
const rangeQuery = z
  .object({ from: z.coerce.date(), to: z.coerce.date(), locationId: uuid.optional() })
  .refine((q) => q.to > q.from && q.to.getTime() - q.from.getTime() <= 62 * 86_400_000, 'choose a range of up to about two months');

const shiftFields = {
  locationId: uuid,
  userId: uuid.nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  position: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
};
const createBody = z.object(shiftFields).refine((s) => s.endsAt > s.startsAt, 'a shift must end after it starts');
const updateBody = z
  .object(shiftFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'provide at least one field');
const publishBody = z.object({ from: z.coerce.date(), to: z.coerce.date(), locationId: uuid.optional() });

@Controller('schedule')
@RequireModule('scheduling')
export class ScheduleController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  /** Shifts starting in a range. Staff see the published schedule; managers also see drafts. */
  @RequirePermission('scheduling.read')
  @Get()
  async list(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    const canManage = hasPermission(currentTenant().permissions, 'scheduling.manage');
    const s = schema.shifts;
    return this.db.tx
      .select({
        id: s.id,
        locationId: s.locationId,
        locationName: schema.locations.name,
        userId: s.userId,
        userName: schema.users.displayName,
        userEmail: schema.users.email,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        position: s.position,
        notes: s.notes,
        status: s.status,
      })
      .from(s)
      .innerJoin(schema.locations, eq(schema.locations.id, s.locationId))
      .leftJoin(schema.users, eq(schema.users.id, s.userId))
      .where(
        and(
          gte(s.startsAt, q.from),
          lt(s.startsAt, q.to),
          q.locationId ? eq(s.locationId, q.locationId) : undefined,
          canManage ? undefined : eq(s.status, 'published'),
        ),
      )
      .orderBy(asc(s.startsAt), asc(s.id));
  }

  @RequirePermission('scheduling.manage')
  @Post('shifts')
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    await this.validate(body);
    const [shift] = await this.db.tx
      .insert(schema.shifts)
      .values({ tenantId: currentTenant().tenantId, ...body, position: body.position ?? null, notes: body.notes ?? null, createdBy: currentUserId() })
      .returning();
    return shift;
  }

  /** Editing a published shift keeps it published (the change is visible right away). */
  @RequirePermission('scheduling.manage')
  @Patch('shifts/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const [current] = await this.db.tx.select().from(schema.shifts).where(eq(schema.shifts.id, id));
    if (!current) throw new NotFoundException('Shift not found');
    const next = { ...current, ...body };
    if (next.endsAt <= next.startsAt) throw new BadRequestException('A shift must end after it starts');
    await this.validate(next);
    const [shift] = await this.db.tx.update(schema.shifts).set({ ...body, updatedAt: new Date() }).where(eq(schema.shifts.id, id)).returning();
    if (current.status === 'published') await this.events.record('shift.changed', { type: 'shift', id }, { userId: shift!.userId, previousUserId: current.userId });
    return shift;
  }

  @RequirePermission('scheduling.manage')
  @Delete('shifts/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const [shift] = await this.db.tx.delete(schema.shifts).where(eq(schema.shifts.id, id)).returning();
    if (!shift) throw new NotFoundException('Shift not found');
    if (shift.status === 'published') await this.events.record('shift.removed', { type: 'shift', id }, { userId: shift.userId, startsAt: shift.startsAt.toISOString() });
    return { id, deleted: true };
  }

  /** Publishes the draft shifts in a range so staff can see them. */
  @RequirePermission('scheduling.manage')
  @Post('publish')
  async publish(@Body(new ZodPipe(publishBody)) body: z.infer<typeof publishBody>) {
    const published = await this.db.tx
      .update(schema.shifts)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.shifts.status, 'draft'),
          gte(schema.shifts.startsAt, body.from),
          lt(schema.shifts.startsAt, body.to),
          body.locationId ? eq(schema.shifts.locationId, body.locationId) : undefined,
        ),
      )
      .returning({ id: schema.shifts.id, userId: schema.shifts.userId });
    if (published.length) {
      await this.events.record('schedule.published', { type: 'schedule', id: body.from.toISOString() }, {
        from: body.from.toISOString(),
        to: body.to.toISOString(),
        shifts: published.length,
        userIds: [...new Set(published.map((p) => p.userId).filter(Boolean))],
      });
    }
    return { published: published.length };
  }

  private async validate(shift: { locationId: string; userId: string | null; startsAt: Date; endsAt: Date }) {
    if (shift.endsAt.getTime() - shift.startsAt.getTime() > 24 * 3600_000) throw new BadRequestException('A shift can be at most 24 hours');
    const [loc] = await this.db.tx.select({ id: schema.locations.id }).from(schema.locations).where(eq(schema.locations.id, shift.locationId));
    if (!loc) throw new NotFoundException('Location not found');
    if (shift.userId) {
      const [member] = await this.db.tx
        .select({ status: schema.memberships.status })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.userId, shift.userId), inArray(schema.memberships.status, ['active'])));
      if (!member) throw new BadRequestException('That person is not an active member of your team');
    }
  }
}

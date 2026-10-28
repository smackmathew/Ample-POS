import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { ALL_PERMISSIONS, hasPermission } from '@pos/modules';
import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentContext, currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { allowedNext, buildShifts, clockState, localDate, OVERTIME_WEEKLY_MINUTES, weekStart, type Punch } from './timecards';

const uuid = z.string().uuid();
const kind = z.enum(['in', 'out', 'break_start', 'break_end']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const selfPunchBody = z.object({ id: uuid, kind, locationId: uuid.optional() });
const manualPunchBody = z.object({
  id: uuid,
  userId: uuid,
  kind,
  locationId: uuid,
  occurredAt: z.coerce.date(),
  reason: z.string().trim().min(3, 'say why this punch is being added').max(300),
});
const voidBody = z.object({ reason: z.string().trim().min(3, 'say why this punch is wrong').max(300) });
const timecardQuery = z
  .object({ from: isoDate, to: isoDate, userId: uuid.optional() })
  .refine((q) => q.from <= q.to, 'from must be on or before to')
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, 'choose at most about two months');
const approveBody = z.object({ userId: uuid, weekStart: isoDate });

/** Adds days to a YYYY-MM-DD date. */
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

@Controller('timeclock')
@RequireModule('time-clock')
export class TimeClockController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  /** Your clock state, today's punches and what you can do next. */
  @RequirePermission('timeclock.punch')
  @Get('me')
  async me() {
    const userId = currentUserId();
    const punches = await this.activePunches(userId, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() + 60_000));
    const state = clockState(punches);
    const open = buildShifts(punches).find((s) => s.end === null && s.issues.length === 0);
    return { state, allowed: allowedNext(state), currentShift: open ?? null, punches: punches.slice(-8).reverse() };
  }

  /** Clock in/out or start/end a break, now. Resending the same id is a no-op. */
  @RequirePermission('timeclock.punch')
  @Post('punches')
  async punch(@Body(new ZodPipe(selfPunchBody)) body: z.infer<typeof selfPunchBody>) {
    const userId = currentUserId();
    const { device } = currentContext();
    await this.lockPerson(userId);
    const [existing] = await this.db.tx.select({ id: schema.timePunches.id }).from(schema.timePunches).where(eq(schema.timePunches.id, body.id));
    if (existing) return this.me();

    const locationId = device?.locationId ?? body.locationId;
    if (!locationId) throw new BadRequestException('Choose the location you are working at');
    await this.requireLocation(locationId);
    const punches = await this.activePunches(userId, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() + 60_000));
    const state = clockState(punches);
    if (!allowedNext(state).includes(body.kind)) {
      const messages: Record<string, string> = {
        off: 'You are not clocked in',
        working: body.kind === 'in' ? 'You are already clocked in' : 'You are not on a break',
        on_break: body.kind === 'in' ? 'You are already clocked in' : 'You are already on a break',
      };
      throw new ConflictException(messages[state]);
    }
    await this.db.tx.insert(schema.timePunches).values({
      id: body.id,
      tenantId: currentTenant().tenantId,
      userId,
      locationId,
      kind: body.kind,
      // Your own punches are always "now" by the server's clock, not the device's.
      occurredAt: new Date(),
      source: 'self',
      createdBy: userId,
      deviceId: device?.id ?? null,
    });
    await this.events.emit(`timeclock.${body.kind}`, { userId, locationId });
    return this.me();
  }

  /** A manager adds a missed punch for someone else, with a reason. */
  @RequirePermission('timeclock.manage')
  @Post('punches/manual')
  async manualPunch(@Body(new ZodPipe(manualPunchBody)) body: z.infer<typeof manualPunchBody>) {
    this.assertNotOwnTime(body.userId);
    await this.requireMember(body.userId);
    await this.requireLocation(body.locationId);
    if (body.occurredAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('Punches cannot be in the future');
    await this.lockPerson(body.userId);
    const [existing] = await this.db.tx.select({ id: schema.timePunches.id }).from(schema.timePunches).where(eq(schema.timePunches.id, body.id));
    if (!existing) {
      await this.db.tx.insert(schema.timePunches).values({
        id: body.id,
        tenantId: currentTenant().tenantId,
        userId: body.userId,
        locationId: body.locationId,
        kind: body.kind,
        occurredAt: body.occurredAt,
        source: 'manager',
        reason: body.reason,
        createdBy: currentUserId(),
      });
      await this.events.audit('timeclock.punch_added', { type: 'punch', id: body.id }, {
        userId: body.userId,
        kind: body.kind,
        occurredAt: body.occurredAt.toISOString(),
        reason: body.reason,
      });
    }
    return { id: body.id };
  }

  /** Voids a wrong punch. The punch stays on record with who voided it and why. */
  @RequirePermission('timeclock.manage')
  @Post('punches/:id/void')
  async voidPunch(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidBody)) body: z.infer<typeof voidBody>) {
    const [punch] = await this.db.tx.select().from(schema.timePunches).where(eq(schema.timePunches.id, id));
    if (!punch) throw new NotFoundException('Punch not found');
    this.assertNotOwnTime(punch.userId);
    if (punch.voidedAt) return { id, voided: true };
    await this.db.tx
      .update(schema.timePunches)
      .set({ voidedAt: new Date(), voidedBy: currentUserId(), voidReason: body.reason })
      .where(eq(schema.timePunches.id, id));
    await this.events.audit('timeclock.punch_voided', { type: 'punch', id }, { userId: punch.userId, kind: punch.kind, reason: body.reason });
    return { id, voided: true };
  }

  /**
   * Shifts, daily and weekly totals per person for a date range (location
   * calendar days, Monday weeks), with overtime past 40 hours, scheduled time
   * when Scheduling is on, and whether each week is approved.
   */
  @RequirePermission('timeclock.punch')
  @Get('timecards')
  async timecards(@Query(new ZodPipe(timecardQuery)) q: z.infer<typeof timecardQuery>) {
    const me = currentUserId();
    const canManage = hasPermission(currentTenant().permissions, 'timeclock.manage');
    if (!canManage && q.userId && q.userId !== me) throw new ForbiddenException('You can only see your own timecard');
    const onlyUser = canManage ? q.userId : me;

    // Pad the window so shifts that cross midnight or time zones are complete.
    const from = new Date(`${addDays(q.from, -1)}T00:00:00Z`);
    const to = new Date(`${addDays(q.to, 2)}T00:00:00Z`);
    const rows = await this.db.tx
      .select({ punch: schema.timePunches, tz: schema.locations.timezone })
      .from(schema.timePunches)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.timePunches.locationId))
      .where(and(gte(schema.timePunches.occurredAt, from), lt(schema.timePunches.occurredAt, to), onlyUser ? eq(schema.timePunches.userId, onlyUser) : undefined))
      .orderBy(asc(schema.timePunches.occurredAt));
    const tzByLocation = new Map(rows.map((r) => [r.punch.locationId, r.tz]));
    const byUser = new Map<string, Punch[]>();
    // Latest add or void per person per week: an approval older than that is out of date.
    const lastChange = new Map<string, Date>();
    for (const { punch, tz } of rows) {
      const key = `${punch.userId}|${weekStart(localDate(punch.occurredAt, tz))}`;
      const changed = punch.voidedAt && punch.voidedAt > punch.recordedAt ? punch.voidedAt : punch.recordedAt;
      if (!lastChange.has(key) || changed > lastChange.get(key)!) lastChange.set(key, changed);
      if (!punch.voidedAt) byUser.set(punch.userId, [...(byUser.get(punch.userId) ?? []), punch]);
    }

    const people = await this.members(onlyUser ? [onlyUser] : [...byUser.keys()]);
    const scheduled = await this.scheduledMinutes(from, to, onlyUser);
    const approvals = await this.db.tx.select().from(schema.timecardApprovals).where(onlyUser ? eq(schema.timecardApprovals.userId, onlyUser) : undefined);

    const result = [...new Set([...byUser.keys(), ...(onlyUser ? [onlyUser] : [])])].map((userId) => {
      const shifts = buildShifts(byUser.get(userId) ?? [])
        .map((s) => ({ ...s, date: localDate(s.start, tzByLocation.get(s.locationId) ?? 'UTC') }))
        .filter((s) => s.date >= q.from && s.date <= q.to);
      const days = new Map<string, number>();
      for (const s of shifts) days.set(s.date, (days.get(s.date) ?? 0) + s.workedMinutes);
      const weeks = new Map<string, number>();
      for (const [d, m] of days) weeks.set(weekStart(d), (weeks.get(weekStart(d)) ?? 0) + m);
      return {
        user: people.get(userId) ?? { id: userId, email: null, displayName: null },
        shifts,
        days: [...days].map(([date, workedMinutes]) => ({ date, workedMinutes, scheduledMinutes: scheduled.get(`${userId}|${date}`) ?? null })),
        weeks: [...weeks].map(([start, workedMinutes]) => {
          const approval = approvals.find((a) => a.userId === userId && a.weekStart === start);
          const changed = lastChange.get(`${userId}|${start}`);
          return {
            weekStart: start,
            workedMinutes,
            overtimeMinutes: Math.max(0, workedMinutes - OVERTIME_WEEKLY_MINUTES),
            approval: approval
              ? {
                  approvedAt: approval.approvedAt,
                  approvedBy: approval.approvedBy,
                  workedMinutes: approval.workedMinutes,
                  outdated: approval.workedMinutes !== workedMinutes || (changed !== undefined && changed > approval.approvedAt),
                }
              : null,
          };
        }),
        issues: shifts.flatMap((s) => s.issues.map((issue) => ({ date: s.date, issue }))),
        totalMinutes: shifts.reduce((n, s) => n + s.workedMinutes, 0),
      };
    });
    return { from: q.from, to: q.to, people: result.sort((a, b) => (a.user.displayName ?? a.user.email ?? '').localeCompare(b.user.displayName ?? b.user.email ?? '')) };
  }

  /** Signs off a person's week, recording the minutes approved. */
  @RequirePermission('timeclock.manage')
  @Post('approvals')
  async approve(@Body(new ZodPipe(approveBody)) body: z.infer<typeof approveBody>) {
    if (weekStart(body.weekStart) !== body.weekStart) throw new BadRequestException('weekStart must be a Monday');
    this.assertNotOwnTime(body.userId);
    const card = await this.timecards({ from: body.weekStart, to: addDays(body.weekStart, 6), userId: body.userId });
    const person = card.people[0]!;
    if (person.issues.length) throw new ConflictException(`Fix the problems on this timecard first: ${person.issues.map((i) => `${i.date} ${i.issue}`).join('; ')}`);
    const worked = person.weeks.find((w) => w.weekStart === body.weekStart)?.workedMinutes ?? 0;
    await this.db.tx
      .insert(schema.timecardApprovals)
      .values({ tenantId: currentTenant().tenantId, userId: body.userId, weekStart: body.weekStart, workedMinutes: worked, approvedBy: currentUserId() })
      .onConflictDoUpdate({
        target: [schema.timecardApprovals.tenantId, schema.timecardApprovals.userId, schema.timecardApprovals.weekStart],
        set: { workedMinutes: worked, approvedBy: currentUserId(), approvedAt: new Date() },
      });
    await this.events.record('timecard.approved', { type: 'user', id: body.userId }, { weekStart: body.weekStart, workedMinutes: worked });
    return { userId: body.userId, weekStart: body.weekStart, workedMinutes: worked };
  }

  // Helpers --------------------------------------------------------------------

  /** Managers can't change their own hours; only an owner can. */
  private assertNotOwnTime(userId: string) {
    if (userId === currentUserId() && !currentTenant().permissions.includes(ALL_PERMISSIONS)) {
      throw new ForbiddenException('You can’t correct or approve your own time. Ask another manager or the owner.');
    }
  }

  /** Serializes punches for one person so two taps can't both clock in. */
  private async lockPerson(userId: string) {
    await this.db.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`punch:${currentTenant().tenantId}:${userId}`}))`);
  }

  private async activePunches(userId: string, from: Date, to: Date): Promise<(Punch & typeof schema.timePunches.$inferSelect)[]> {
    return this.db.tx
      .select()
      .from(schema.timePunches)
      .where(and(eq(schema.timePunches.userId, userId), isNull(schema.timePunches.voidedAt), gte(schema.timePunches.occurredAt, from), lt(schema.timePunches.occurredAt, to)))
      .orderBy(asc(schema.timePunches.occurredAt));
  }

  private async requireLocation(id: string) {
    const [loc] = await this.db.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.id, id), isNull(schema.locations.archivedAt)));
    if (!loc) throw new NotFoundException('Location not found');
  }

  private async requireMember(userId: string) {
    const [m] = await this.db.tx.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, userId));
    if (!m) throw new NotFoundException('That person is not on your team');
  }

  private async members(userIds: string[]) {
    if (!userIds.length) return new Map<string, { id: string; email: string | null; displayName: string | null }>();
    const rows = await this.db.tx
      .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Published scheduled minutes per person per local day, when Scheduling is on. */
  private async scheduledMinutes(from: Date, to: Date, userId?: string) {
    const out = new Map<string, number>();
    const [on] = await this.db.tx.select({ enabled: schema.tenantModules.enabled }).from(schema.tenantModules).where(eq(schema.tenantModules.moduleId, 'scheduling'));
    if (!on?.enabled) return out;
    const rows = await this.db.tx
      .select({ userId: schema.shifts.userId, startsAt: schema.shifts.startsAt, endsAt: schema.shifts.endsAt, tz: schema.locations.timezone })
      .from(schema.shifts)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.shifts.locationId))
      .where(and(eq(schema.shifts.status, 'published'), gte(schema.shifts.startsAt, from), lt(schema.shifts.startsAt, to), userId ? eq(schema.shifts.userId, userId) : undefined));
    for (const r of rows) {
      if (!r.userId) continue;
      const key = `${r.userId}|${localDate(r.startsAt, r.tz)}`;
      out.set(key, (out.get(key) ?? 0) + Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000));
    }
    return out;
  }
}

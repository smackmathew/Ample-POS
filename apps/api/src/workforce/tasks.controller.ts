import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission } from '@pos/modules';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { localDate } from './timecards';

type Checklist = typeof schema.checklists.$inferSelect;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const todayQuery = z.object({ locationId: uuid.optional(), date: isoDate.optional(), all: z.enum(['true', 'false']).default('false') });

const checklistFields = z.object({
  title: z.string().trim().min(1).max(120),
  locationId: uuid.nullable().default(null),
  recurrence: z.enum(['once', 'daily', 'weekly']),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  dueDate: isoDate.nullable().default(null),
  assigneeUserId: uuid.nullable().default(null),
  assigneeRoleKey: z.string().max(60).nullable().default(null),
  items: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
});
const checkRules = <T extends { recurrence: string; weekdays: number[]; dueDate: string | null; assigneeUserId: string | null; assigneeRoleKey: string | null }>(c: T) =>
  (c.recurrence !== 'weekly' || c.weekdays.length > 0) &&
  (c.recurrence !== 'once' || c.dueDate !== null) &&
  !(c.assigneeUserId && c.assigneeRoleKey);
const RULES_MESSAGE = 'weekly lists need weekdays, one-off lists need a due date, and assign to a person or a role (not both)';
const createBody = checklistFields.refine(checkRules, RULES_MESSAGE);
const updateBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  assigneeUserId: uuid.nullable().optional(),
  assigneeRoleKey: z.string().max(60).nullable().optional(),
  archived: z.boolean().optional(),
  /** Replaces the items: keep an item by passing its id, add one by leaving id out; missing ones are archived. */
  items: z.array(z.object({ id: uuid.optional(), label: z.string().trim().min(1).max(200) })).min(1).max(100).optional(),
});
const completeBody = z.object({ note: z.string().trim().max(300).optional() });

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD date. */
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

@Controller('tasks')
@RequireModule('tasks')
export class TasksController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  /**
   * Checklists due on a day (today at the location by default) that are for
   * you, your role or anyone. One-off lists stay until they're finished.
   * Managers can pass all=true to see everyone's.
   */
  @RequirePermission('tasks.complete')
  @Get('today')
  async today(@Query(new ZodPipe(todayQuery)) q: z.infer<typeof todayQuery>) {
    const { permissions, roleKey } = currentTenant();
    const me = currentUserId();
    const seeAll = q.all === 'true' && hasPermission(permissions, 'tasks.manage');
    let date = q.date;
    if (!date) {
      const [loc] = q.locationId ? await this.db.tx.select({ tz: schema.locations.timezone }).from(schema.locations).where(eq(schema.locations.id, q.locationId)) : [];
      date = localDate(new Date(), loc?.tz ?? 'UTC');
    }

    const c = schema.checklists;
    const candidates = await this.db.tx
      .select()
      .from(c)
      .where(
        and(
          isNull(c.archivedAt),
          q.locationId ? or(isNull(c.locationId), eq(c.locationId, q.locationId)) : undefined,
          seeAll ? undefined : or(eq(c.assigneeUserId, me), eq(c.assigneeRoleKey, roleKey), and(isNull(c.assigneeUserId), isNull(c.assigneeRoleKey))),
        ),
      )
      .orderBy(asc(c.title));

    const due = candidates.filter(
      (cl) => cl.recurrence === 'daily' || (cl.recurrence === 'weekly' && cl.weekdays.includes(weekday(date!))) || (cl.recurrence === 'once' && cl.dueDate! <= date!),
    );
    const lists = [];
    for (const cl of due) {
      const run = await this.runFor(cl, cl.recurrence === 'once' ? cl.dueDate! : date);
      const view = await this.runView(cl, run.id);
      // A finished one-off list from an earlier day has nothing left to show.
      if (cl.recurrence === 'once' && cl.dueDate! < date && view.done === view.total) continue;
      lists.push({ ...view, overdue: cl.recurrence === 'once' && cl.dueDate! < date });
    }
    return { date, lists };
  }

  @RequirePermission('tasks.complete')
  @Post('runs/:runId/items/:itemId/complete')
  async complete(@Param('runId', ParseUUIDPipe) runId: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body(new ZodPipe(completeBody)) body: z.infer<typeof completeBody>) {
    const { checklist } = await this.runAndItem(runId, itemId);
    this.assertCanWork(checklist);
    const inserted = await this.db.tx
      .insert(schema.checklistCompletions)
      .values({ tenantId: checklist.tenantId, runId, itemId, completedBy: currentUserId(), note: body.note ?? null })
      .onConflictDoNothing()
      .returning({ id: schema.checklistCompletions.id });
    if (inserted.length) await this.events.emit('task.completed', { checklistId: checklist.id, runId, itemId, userId: currentUserId() });
    return this.runView(checklist, runId);
  }

  /** Unticks an item. The original completion stays on record, marked as undone. */
  @RequirePermission('tasks.complete')
  @Post('runs/:runId/items/:itemId/undo')
  async undo(@Param('runId', ParseUUIDPipe) runId: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    const { checklist } = await this.runAndItem(runId, itemId);
    const [current] = await this.db.tx
      .select()
      .from(schema.checklistCompletions)
      .where(and(eq(schema.checklistCompletions.runId, runId), eq(schema.checklistCompletions.itemId, itemId), isNull(schema.checklistCompletions.undoneAt)));
    if (!current) return this.runView(checklist, runId);
    if (current.completedBy !== currentUserId() && !hasPermission(currentTenant().permissions, 'tasks.manage')) {
      throw new ForbiddenException('Only the person who ticked this, or a manager, can untick it');
    }
    await this.db.tx.update(schema.checklistCompletions).set({ undoneAt: new Date(), undoneBy: currentUserId() }).where(eq(schema.checklistCompletions.id, current.id));
    return this.runView(checklist, runId);
  }

  // Managing checklists -------------------------------------------------------

  @RequirePermission('tasks.manage')
  @Get('checklists')
  async list() {
    const lists = await this.db.tx.select().from(schema.checklists).where(isNull(schema.checklists.archivedAt)).orderBy(asc(schema.checklists.title));
    const items = lists.length
      ? await this.db.tx
          .select()
          .from(schema.checklistItems)
          .where(and(inArray(schema.checklistItems.checklistId, lists.map((l) => l.id)), isNull(schema.checklistItems.archivedAt)))
          .orderBy(asc(schema.checklistItems.position))
      : [];
    return lists.map((l) => ({ ...l, items: items.filter((i) => i.checklistId === l.id).map((i) => ({ id: i.id, label: i.label })) }));
  }

  @RequirePermission('tasks.manage')
  @Post('checklists')
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    await this.validateAssignee(body);
    const { items, weekdays, ...fields } = body;
    const [checklist] = await this.db.tx
      .insert(schema.checklists)
      .values({ tenantId: currentTenant().tenantId, ...fields, weekdays: body.recurrence === 'weekly' ? [...new Set(weekdays)].sort() : [], createdBy: currentUserId() })
      .returning();
    await this.db.tx.insert(schema.checklistItems).values(items.map((label, position) => ({ tenantId: checklist!.tenantId, checklistId: checklist!.id, position, label })));
    await this.events.audit('checklist.created', { type: 'checklist', id: checklist!.id }, { title: body.title });
    return (await this.list()).find((l) => l.id === checklist!.id);
  }

  @RequirePermission('tasks.manage')
  @Patch('checklists/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const [checklist] = await this.db.tx.select().from(schema.checklists).where(eq(schema.checklists.id, id));
    if (!checklist) throw new NotFoundException('Checklist not found');
    const assignee = {
      assigneeUserId: body.assigneeUserId !== undefined ? body.assigneeUserId : checklist.assigneeUserId,
      assigneeRoleKey: body.assigneeRoleKey !== undefined ? body.assigneeRoleKey : checklist.assigneeRoleKey,
    };
    if (assignee.assigneeUserId && assignee.assigneeRoleKey) throw new BadRequestException('Assign to a person or a role, not both');
    await this.validateAssignee(assignee);
    await this.db.tx
      .update(schema.checklists)
      .set({ ...assignee, ...(body.title ? { title: body.title } : {}), ...(body.archived !== undefined ? { archivedAt: body.archived ? new Date() : null } : {}) })
      .where(eq(schema.checklists.id, id));

    if (body.items) {
      const existing = await this.db.tx.select().from(schema.checklistItems).where(and(eq(schema.checklistItems.checklistId, id), isNull(schema.checklistItems.archivedAt)));
      const keep = new Set(body.items.map((i) => i.id).filter(Boolean));
      const unknown = [...keep].filter((k) => !existing.some((e) => e.id === k));
      if (unknown.length) throw new BadRequestException('Some items do not belong to this checklist');
      const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
      // Removed items are archived, not deleted, so past completions still make sense.
      if (removed.length) await this.db.tx.update(schema.checklistItems).set({ archivedAt: new Date() }).where(inArray(schema.checklistItems.id, removed));
      for (const [position, item] of body.items.entries()) {
        if (item.id) await this.db.tx.update(schema.checklistItems).set({ label: item.label, position }).where(eq(schema.checklistItems.id, item.id));
        else await this.db.tx.insert(schema.checklistItems).values({ tenantId: checklist.tenantId, checklistId: id, position, label: item.label });
      }
    }
    await this.events.audit('checklist.updated', { type: 'checklist', id }, { title: body.title, archived: body.archived });
    return body.archived ? { id, archived: true } : (await this.list()).find((l) => l.id === id);
  }

  // Helpers ---------------------------------------------------------------------

  private async runFor(checklist: Checklist, runDate: string) {
    await this.db.tx
      .insert(schema.checklistRuns)
      .values({ tenantId: checklist.tenantId, checklistId: checklist.id, runDate })
      .onConflictDoNothing();
    const [run] = await this.db.tx
      .select()
      .from(schema.checklistRuns)
      .where(and(eq(schema.checklistRuns.checklistId, checklist.id), eq(schema.checklistRuns.runDate, runDate)));
    return run!;
  }

  private async runView(checklist: Checklist, runId: string) {
    const items = await this.db.tx
      .select({ id: schema.checklistItems.id, label: schema.checklistItems.label })
      .from(schema.checklistItems)
      .where(and(eq(schema.checklistItems.checklistId, checklist.id), isNull(schema.checklistItems.archivedAt)))
      .orderBy(asc(schema.checklistItems.position));
    const completions = await this.db.tx
      .select({
        itemId: schema.checklistCompletions.itemId,
        completedAt: schema.checklistCompletions.completedAt,
        note: schema.checklistCompletions.note,
        by: sql<string>`coalesce(${schema.users.displayName}, ${schema.users.email})`,
        completedBy: schema.checklistCompletions.completedBy,
      })
      .from(schema.checklistCompletions)
      .leftJoin(schema.users, eq(schema.users.id, schema.checklistCompletions.completedBy))
      .where(and(eq(schema.checklistCompletions.runId, runId), isNull(schema.checklistCompletions.undoneAt)));
    const [run] = await this.db.tx.select({ runDate: schema.checklistRuns.runDate }).from(schema.checklistRuns).where(eq(schema.checklistRuns.id, runId));
    const viewItems = items.map((i) => ({ ...i, completion: completions.find((c) => c.itemId === i.id) ?? null }));
    return {
      runId,
      runDate: run!.runDate,
      checklist: { id: checklist.id, title: checklist.title, recurrence: checklist.recurrence, assigneeUserId: checklist.assigneeUserId, assigneeRoleKey: checklist.assigneeRoleKey },
      items: viewItems,
      done: viewItems.filter((i) => i.completion).length,
      total: viewItems.length,
    };
  }

  private async runAndItem(runId: string, itemId: string) {
    const [row] = await this.db.tx
      .select({ checklist: schema.checklists })
      .from(schema.checklistRuns)
      .innerJoin(schema.checklists, eq(schema.checklists.id, schema.checklistRuns.checklistId))
      .where(eq(schema.checklistRuns.id, runId));
    if (!row) throw new NotFoundException('Checklist not found');
    const [item] = await this.db.tx
      .select({ id: schema.checklistItems.id })
      .from(schema.checklistItems)
      .where(and(eq(schema.checklistItems.id, itemId), eq(schema.checklistItems.checklistId, row.checklist.id), isNull(schema.checklistItems.archivedAt)));
    if (!item) throw new NotFoundException('Item not found on this checklist');
    if (row.checklist.archivedAt) throw new ConflictException('This checklist was archived');
    return { checklist: row.checklist };
  }

  private assertCanWork(checklist: Checklist) {
    const { permissions, roleKey } = currentTenant();
    if (hasPermission(permissions, 'tasks.manage')) return;
    const forMe =
      (!checklist.assigneeUserId && !checklist.assigneeRoleKey) || checklist.assigneeUserId === currentUserId() || checklist.assigneeRoleKey === roleKey;
    if (!forMe) throw new ForbiddenException('This checklist is assigned to someone else');
  }

  private async validateAssignee(a: { assigneeUserId: string | null; assigneeRoleKey: string | null }) {
    if (a.assigneeUserId) {
      const [m] = await this.db.tx.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, a.assigneeUserId));
      if (!m) throw new BadRequestException('That person is not on your team');
    }
    if (a.assigneeRoleKey) {
      const [r] = await this.db.tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, a.assigneeRoleKey));
      if (!r) throw new BadRequestException('Role not found');
    }
  }
}

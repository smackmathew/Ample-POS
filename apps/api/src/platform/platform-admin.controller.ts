import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { schema, type Transaction } from '@pos/db';
import { enabledDependents, getModule, isModuleId, missingDependencies, MODULES, PLAN_IDS, WEBSITE_ADDON_IDS, WEBSITE_TOOL, type ModuleId } from '@pos/modules';
import { planSettings, websiteAddonSettings } from '../core/plan-settings';
import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LIVE_STATUSES } from '../billing/provider';
import { standing, type Standing } from '../billing/standing';
import { NoTenant } from '../core/decorators';
import { PlatformDb } from '../core/platform-db';
import { ZodPipe } from '../core/zod';
import { PlatformAccess, type PlatformAdmin } from './platform-access';

const n = (v: unknown) => Number(v ?? 0);
const days = z.coerce.number().int().min(1).max(365).default(30);
const overviewQuery = z.object({ days });
const companiesQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'free', 'trial', 'active', 'past_due', 'lapsed', 'suspended']).default('all'),
});
const toolBody = z
  .object({ enabled: z.boolean().optional(), comped: z.boolean().optional(), blocked: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one setting');
const suspendBody = z.object({ reason: z.string().trim().min(1, 'Say why, so the business and other admins know').max(300) });
const pageQuery = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  tenantId: z.string().uuid().optional(),
});
const transactionsQuery = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const price = z.number().int().min(0).max(10_000_000).nullable().optional();
const planPriceBody = z
  .object({
    baseMinor: price,
    extraLocationMinor: price,
    websiteMaintenanceMinor: price,
    registersPerLocation: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one setting');
const addonPriceBody = z.object({ setupMinor: z.number().int().min(0).max(100_000_000).nullable() });
const companyPlanBody = z
  .object({ plan: z.enum(PLAN_IDS).optional(), websiteAddon: z.enum(WEBSITE_ADDON_IDS).nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one setting');
const reasonBody = z.object({ reason: z.string().trim().min(3, 'Say why you’re looking, for the business’s audit log').max(300) });
const nameBody = z.object({ name: z.string().trim().min(1).max(100) });
const trialBody = z
  .object({
    trialEndsAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31')
      .optional(),
    /** Adds days to the trial: from its current end, or from today if it already ended. */
    addDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((b) => Boolean(b.trialEndsAt) !== Boolean(b.addDays), 'Give a date or a number of days');
const freeBody = z.object({ free: z.boolean(), reason: z.string().trim().max(300).optional() });
const ownerBody = z.object({
  userId: z.string().uuid(),
  /** What current owners become: a role key such as 'manager', or null to keep them as owners too. */
  previousOwnersBecome: z.string().trim().min(1).max(60).nullable().default('manager'),
});
/** How long a support view lasts before it has to be opened again. */
const SUPPORT_MINUTES = 60;
const platformToolBody = z
  .object({ available: z.boolean().optional(), monthlyPriceMinor: z.number().int().min(0).max(10_000_000).nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one setting');

export type Severity = 'high' | 'medium' | 'low';
export interface Issue {
  key: string;
  tenantId: string;
  tenantName: string;
  severity: Severity;
  title: string;
  detail: string | null;
  since: string;
}

type BillingRow = {
  status: string | null;
  trial_ends_at: Date | string;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  items: { moduleId: string; quantity: number; unitMinor?: number }[];
  free_since?: Date | string | null;
};

function standingOf(b: BillingRow | null | undefined): Standing | null {
  if (!b) return null;
  return standing({
    status: b.status,
    trialEndsAt: new Date(b.trial_ends_at),
    currentPeriodEnd: b.current_period_end ? new Date(b.current_period_end) : null,
    cancelAtPeriodEnd: b.cancel_at_period_end,
    freeSince: b.free_since ? new Date(b.free_since) : null,
  });
}

/** Monthly recurring revenue from a live subscription's items. */
function mrrOf(b: BillingRow | null | undefined): number {
  if (!b || !b.status || !LIVE_STATUSES.has(b.status)) return 0;
  return (b.items ?? []).reduce((t, i) => t + (i.unitMinor ?? (isModuleId(i.moduleId) ? getModule(i.moduleId).monthlyPriceMinor : 0)) * i.quantity, 0);
}

/**
 * The super admin dashboard: every business on the platform, their tools,
 * billing, activity, transactions and problems, and platform-wide tool
 * settings. Only for PLATFORM_ADMIN_EMAILS (see PlatformAccess).
 */
@Controller('platform')
@NoTenant()
export class PlatformAdminController {
  constructor(
    private readonly access: PlatformAccess,
    private readonly platform: PlatformDb,
  ) {}

  /** Whether the signed-in person can use the dashboard, and if not, why. */
  @Get('access')
  async whoami() {
    const result = await this.access.check();
    return result.ok ? { admin: true, email: result.admin.email } : { admin: false, code: result.code, message: result.message };
  }

  @Get('overview')
  async overview(@Query(new ZodPipe(overviewQuery)) q: z.infer<typeof overviewQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const since = sql`now() - make_interval(days => ${q.days})`;
      const tenants = await tx.execute<{ id: string; created_at: Date; suspended_at: Date | null } & BillingRow>(sql`
        select t.id, t.created_at, t.suspended_at, b.status, b.trial_ends_at, b.current_period_end, b.cancel_at_period_end, b.items, b.free_since
        from tenants t left join tenant_billing b on b.tenant_id = t.id`);
      const byStanding: Record<Standing, number> = { free: 0, trial: 0, active: 0, past_due: 0, lapsed: 0 };
      let mrrMinor = 0;
      for (const t of tenants) {
        const s = t.trial_ends_at ? standingOf(t) : null;
        if (s) byStanding[s]++;
        mrrMinor += t.trial_ends_at ? mrrOf(t) : 0;
      }
      const [sales] = await tx.execute<{ count: string; gross: string; refunds: string }>(sql`
        select count(*) as count, coalesce(sum(total_minor), 0) as gross,
               (select coalesce(sum(amount_minor), 0) from refunds where created_at >= ${since}) as refunds
        from sales where status = 'completed' and completed_at >= ${since}`);
      const daily = await tx.execute<{ day: string; sales: string; gross: string; signups: string }>(sql`
        with d as (select generate_series((now() - make_interval(days => ${q.days - 1}))::date, now()::date, '1 day')::date as day)
        select d.day::text as day,
               (select count(*) from sales s where s.status = 'completed' and s.completed_at::date = d.day) as sales,
               (select coalesce(sum(total_minor), 0) from sales s where s.status = 'completed' and s.completed_at::date = d.day) as gross,
               (select count(*) from tenants t where t.created_at::date = d.day) as signups
        from d order by d.day`);
      const tenders = await tx.execute<{ method: string; amount: string }>(sql`
        select p.method, coalesce(sum(p.amount_minor), 0) as amount from payments p
        where p.status = 'succeeded' and p.created_at >= ${since} group by p.method`);
      const top = await tx.execute<{ id: string; name: string; gross: string; count: string }>(sql`
        select t.id, t.name, coalesce(sum(s.total_minor), 0) as gross, count(s.id) as count
        from tenants t join sales s on s.tenant_id = t.id and s.status = 'completed' and s.completed_at >= ${since}
        group by t.id, t.name order by 3 desc limit 5`);
      const [users] = await tx.execute<{ active: string; total: string }>(sql`
        select count(*) filter (where last_seen_at >= now() - interval '7 days') as active, count(*) as total from users`);
      const issues = await this.findIssues(tx);
      const merchants = await tx.execute<{ mode: string; count: string }>(sql`
        select case when mode = 'platform' and not charges_enabled then 'pending' else mode end as mode, count(*) as count
        from merchant_accounts group by 1`);
      return {
        days: q.days,
        merchants: Object.fromEntries(merchants.map((m) => [m.mode, n(m.count)])),
        plans: Object.fromEntries(
          (await tx.execute<{ plan: string; count: string }>(sql`select plan, count(*) as count from tenant_billing group by plan`)).map((p) => [
            p.plan,
            n(p.count),
          ]),
        ),
        websites: n((await tx.execute<{ count: string }>(sql`select count(*) as count from tenant_billing where website_addon is not null`))[0]?.count),
        companies: {
          total: tenants.length,
          new: tenants.filter((t) => new Date(t.created_at).getTime() >= Date.now() - q.days * 86_400_000).length,
          suspended: tenants.filter((t) => t.suspended_at).length,
          byStanding,
        },
        mrrMinor,
        sales: { count: n(sales?.count), grossMinor: n(sales?.gross), refundsMinor: n(sales?.refunds) },
        daily: daily.map((d) => ({ date: d.day, sales: n(d.sales), grossMinor: n(d.gross), signups: n(d.signups) })),
        tenders: Object.fromEntries(tenders.map((t) => [t.method, n(t.amount)])),
        topCompanies: top.map((t) => ({ id: t.id, name: t.name, grossMinor: n(t.gross), sales: n(t.count) })),
        users: { activeLast7Days: n(users?.active), total: n(users?.total) },
        issues: { total: issues.length, high: issues.filter((i) => i.severity === 'high').length },
      };
    });
  }

  @Get('companies')
  async companies(@Query(new ZodPipe(companiesQuery)) q: z.infer<typeof companiesQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const like = q.search ? `%${q.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const rows = await tx.execute<
        {
          id: string;
          name: string;
          slug: string;
          created_at: Date;
          suspended_at: Date | null;
          suspended_reason: string | null;
          owner_email: string | null;
          tools: string;
          merchant: string | null;
          plan: string | null;
          website_addon: string | null;
          locations: string;
          members: string;
          sales30: string;
          gross30: string;
          last_activity: Date | null;
        } & BillingRow
      >(sql`
        select t.id, t.name, t.slug, t.created_at, t.suspended_at, t.suspended_reason,
               b.status, b.trial_ends_at, b.current_period_end, b.cancel_at_period_end, b.items, b.free_since, b.plan, b.website_addon,
               (select u.email from memberships m join roles r on r.id = m.role_id join users u on u.id = m.user_id
                 where m.tenant_id = t.id and r.key = 'owner' order by m.created_at limit 1) as owner_email,
               (select count(*) from tenant_modules tm where tm.tenant_id = t.id and tm.enabled) as tools,
               (select ma.mode || case when ma.mode = 'platform' and not ma.charges_enabled then ':pending' else '' end from merchant_accounts ma where ma.tenant_id = t.id) as merchant,
               (select count(*) from locations l where l.tenant_id = t.id and l.archived_at is null) as locations,
               (select count(*) from memberships m where m.tenant_id = t.id and m.status = 'active') as members,
               (select count(*) from sales s where s.tenant_id = t.id and s.status = 'completed' and s.completed_at >= now() - interval '30 days') as sales30,
               (select coalesce(sum(total_minor), 0) from sales s where s.tenant_id = t.id and s.status = 'completed' and s.completed_at >= now() - interval '30 days') as gross30,
               greatest((select max(created_at) from audit_log a where a.tenant_id = t.id), (select max(created_at) from sales s where s.tenant_id = t.id)) as last_activity
        from tenants t left join tenant_billing b on b.tenant_id = t.id
        ${like ? sql`where lower(t.name) like ${like} or t.slug like ${like} or exists (select 1 from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id and lower(u.email) like ${like})` : sql``}
        order by t.created_at desc limit 500`);
      const issues = await this.findIssues(tx);
      return rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          createdAt: r.created_at,
          suspendedAt: r.suspended_at,
          suspendedReason: r.suspended_reason,
          ownerEmail: r.owner_email,
          standing: r.trial_ends_at ? standingOf(r) : null,
          trialEndsAt: r.trial_ends_at,
          mrrMinor: r.trial_ends_at ? mrrOf(r) : 0,
          plan: r.plan,
          websiteAddon: r.website_addon,
          toolsOn: n(r.tools),
          // off, platform, platform:pending (onboarding not finished) or own
          merchant: r.merchant ?? 'off',
          locations: n(r.locations),
          members: n(r.members),
          sales30: n(r.sales30),
          gross30Minor: n(r.gross30),
          lastActivityAt: r.last_activity,
          issues: issues.filter((i) => i.tenantId === r.id).length,
        }))
        .filter((c) => (q.status === 'all' ? true : q.status === 'suspended' ? Boolean(c.suspendedAt) : c.standing === q.status));
    });
  }

  @Get('companies/:id')
  async company(@Param('id', ParseUUIDPipe) id: string) {
    await this.access.require();
    return this.platform.run((tx) => this.companyDetail(tx, id));
  }

  /** Turn a tool on or off for one business, make it free there, or block the business from turning it on. */
  @Put('companies/:id/tools/:moduleId')
  async setTool(@Param('id', ParseUUIDPipe) id: string, @Param('moduleId') moduleId: string, @Body(new ZodPipe(toolBody)) body: z.infer<typeof toolBody>) {
    const admin = await this.access.require();
    if (!isModuleId(moduleId)) throw new NotFoundException(`Unknown tool: ${moduleId}`);
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const rows = await tx.select().from(schema.tenantModules).where(eq(schema.tenantModules.tenantId, id));
      const current = rows.find((r) => r.moduleId === moduleId);
      const enabled = new Set(
        rows
          .filter((r) => r.enabled)
          .map((r) => r.moduleId)
          .filter(isModuleId),
      );
      const next = {
        enabled: body.blocked ? false : (body.enabled ?? current?.enabled ?? false),
        comped: body.comped ?? current?.comped ?? false,
        blocked: body.blocked ?? current?.blocked ?? false,
      };
      if (next.enabled && !(current?.enabled ?? false)) {
        const missing = missingDependencies(moduleId, enabled);
        if (missing.length)
          throw new ConflictException({ code: 'missing_dependencies', message: `Turn on ${missing.map((m) => getModule(m).name).join(', ')} first` });
      }
      if (!next.enabled && (current?.enabled ?? false)) {
        const dependents = enabledDependents(moduleId, enabled);
        if (dependents.length)
          throw new ConflictException({ code: 'has_dependents', message: `Turn off ${dependents.map((m) => getModule(m).name).join(', ')} first` });
      }
      await tx
        .insert(schema.tenantModules)
        .values({ tenantId: id, moduleId, ...next, updatedBy: admin.userId })
        .onConflictDoUpdate({
          target: [schema.tenantModules.tenantId, schema.tenantModules.moduleId],
          set: { ...next, updatedAt: new Date(), updatedBy: admin.userId },
        });
      const changes = { from: { enabled: current?.enabled ?? false, comped: current?.comped ?? false, blocked: current?.blocked ?? false }, to: next };
      // The business sees it in its own audit log, and billing follows the change.
      const topic = next.enabled !== changes.from.enabled ? (next.enabled ? 'module.enabled' : 'module.disabled') : 'billing.items_changed';
      await this.tenantEvent(tx, id, admin, topic, { type: 'module', id: moduleId }, changes);
      await this.log(tx, admin, 'tool.changed', id, { moduleId, ...changes });
      return this.companyDetail(tx, id);
    });
  }

  @Post('companies/:id/suspend')
  @HttpCode(200)
  async suspend(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(suspendBody)) body: z.infer<typeof suspendBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      await tx.update(schema.tenants).set({ suspendedAt: new Date(), suspendedReason: body.reason }).where(eq(schema.tenants.id, id));
      await this.tenantEvent(tx, id, admin, 'business.suspended', { type: 'tenant', id }, { reason: body.reason });
      await this.log(tx, admin, 'company.suspended', id, { reason: body.reason });
      return this.companyDetail(tx, id);
    });
  }

  @Post('companies/:id/restore')
  @HttpCode(200)
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      await tx.update(schema.tenants).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.tenants.id, id));
      await this.tenantEvent(tx, id, admin, 'business.restored', { type: 'tenant', id }, {});
      await this.log(tx, admin, 'company.restored', id, {});
      return this.companyDetail(tx, id);
    });
  }

  /** Move a business to another plan, or give it (or take away) the online store. Stores added here carry no setup fee. */
  @Put('companies/:id/plan')
  async setCompanyPlan(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(companyPlanBody)) body: z.infer<typeof companyPlanBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const [before] = await tx
        .select({ plan: schema.tenantBilling.plan, websiteAddon: schema.tenantBilling.websiteAddon })
        .from(schema.tenantBilling)
        .where(eq(schema.tenantBilling.tenantId, id));
      if (!before) throw new NotFoundException('This business has no billing record');
      await tx
        .update(schema.tenantBilling)
        .set({
          ...(body.plan ? { plan: body.plan } : {}),
          // An option set by support carries no setup fee: it counts as paid.
          ...(body.websiteAddon !== undefined
            ? {
                websiteAddon: body.websiteAddon,
                ...(body.websiteAddon
                  ? {
                      websiteSetupChargedAt: new Date(),
                      websiteSetupPaidMinor: sql`greatest(${schema.tenantBilling.websiteSetupPaidMinor}, ${(await websiteAddonSettings(tx)).get(body.websiteAddon)!.setupMinor})`,
                    }
                  : {}),
              }
            : {}),
        })
        .where(eq(schema.tenantBilling.tenantId, id));
      if (body.websiteAddon === null) {
        await tx
          .update(schema.tenantModules)
          .set({ enabled: false, updatedAt: new Date(), updatedBy: admin.userId })
          .where(and(eq(schema.tenantModules.tenantId, id), eq(schema.tenantModules.moduleId, WEBSITE_TOOL)));
      }
      await this.tenantEvent(tx, id, admin, 'billing.items_changed', { type: 'plan', id: body.plan ?? before.plan }, { from: before, to: body });
      await this.log(tx, admin, 'company.plan_changed', id, { from: before, to: body });
      return this.companyDetail(tx, id);
    });
  }

  /**
   * Opens a business read-only, as if you were its owner, for an hour. The
   * business sees the visit (and your reason) in its audit log.
   */
  @Post('companies/:id/support')
  @HttpCode(200)
  async startSupport(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const s = schema.platformSupportSessions;
      await tx
        .update(s)
        .set({ endedAt: new Date() })
        .where(and(eq(s.tenantId, id), eq(s.adminUserId, admin.userId), isNull(s.endedAt)));
      const [session] = await tx
        .insert(s)
        .values({ tenantId: id, adminUserId: admin.userId, reason: body.reason, expiresAt: new Date(Date.now() + SUPPORT_MINUTES * 60_000) })
        .returning();
      await tx.insert(schema.auditLog).values({
        tenantId: id,
        actorUserId: admin.userId,
        action: 'support.view_started',
        targetType: 'tenant',
        targetId: id,
        data: { by: 'Ample POS support', email: admin.email, reason: body.reason, minutes: SUPPORT_MINUTES },
      });
      await this.log(tx, admin, 'company.support_view_started', id, { reason: body.reason });
      return { sessionId: session!.id, expiresAt: session!.expiresAt };
    });
  }

  @Post('companies/:id/support/end')
  @HttpCode(200)
  async endSupport(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const s = schema.platformSupportSessions;
      const ended = await tx
        .update(s)
        .set({ endedAt: new Date() })
        .where(and(eq(s.tenantId, id), eq(s.adminUserId, admin.userId), isNull(s.endedAt), gt(s.expiresAt, sql`now()`)))
        .returning({ id: s.id });
      if (ended.length) {
        await tx.insert(schema.auditLog).values({
          tenantId: id,
          actorUserId: admin.userId,
          action: 'support.view_ended',
          targetType: 'tenant',
          targetId: id,
          data: { by: 'Ample POS support', email: admin.email },
        });
      }
      return { ended: ended.length > 0 };
    });
  }

  @Put('companies/:id/name')
  async rename(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(nameBody)) body: z.infer<typeof nameBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const [before] = await tx.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, id));
      await tx.update(schema.tenants).set({ name: body.name }).where(eq(schema.tenants.id, id));
      await this.tenantEvent(tx, id, admin, 'tenant.updated', { type: 'tenant', id }, { name: body.name, previousName: before!.name });
      await this.log(tx, admin, 'company.renamed', id, { from: before!.name, to: body.name });
      return this.companyDetail(tx, id);
    });
  }

  /** Moves the end of the free trial. Only matters until the business subscribes. */
  @Put('companies/:id/trial')
  async setTrial(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(trialBody)) body: z.infer<typeof trialBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const [before] = await tx
        .select({ trialEndsAt: schema.tenantBilling.trialEndsAt })
        .from(schema.tenantBilling)
        .where(eq(schema.tenantBilling.tenantId, id));
      if (!before) throw new NotFoundException('This business has no billing record');
      const end = body.addDays
        ? new Date(Math.max(before.trialEndsAt.getTime(), Date.now()) + body.addDays * 86_400_000)
        : new Date(`${body.trialEndsAt}T23:59:59Z`);
      if (Number.isNaN(end.getTime())) throw new BadRequestException('That isn’t a date');
      if (end.getTime() > Date.now() + 366 * 86_400_000) throw new BadRequestException('A trial can be at most a year from today');
      await tx.update(schema.tenantBilling).set({ trialEndsAt: end }).where(eq(schema.tenantBilling.tenantId, id));
      await tx.insert(schema.auditLog).values({
        tenantId: id,
        actorUserId: admin.userId,
        action: 'billing.trial_changed',
        targetType: 'tenant',
        targetId: id,
        data: { by: 'Ample POS support', from: before.trialEndsAt, to: end },
      });
      await this.log(tx, admin, 'company.trial_changed', id, { from: before.trialEndsAt, to: end });
      return this.companyDetail(tx, id);
    });
  }

  /**
   * Makes a business free (staff, testing, partners) or ends that. A free
   * business is never billed and its paid tools never go read-only. Ending it
   * starts a 14-day trial if the old one has run out, so nobody is locked out at once.
   */
  @Put('companies/:id/free')
  async setFree(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(freeBody)) body: z.infer<typeof freeBody>) {
    const admin = await this.access.require();
    if (body.free && !body.reason) throw new BadRequestException('Say why it’s free, e.g. “Our own test business”');
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const b = schema.tenantBilling;
      const [before] = await tx.select({ freeSince: b.freeSince, trialEndsAt: b.trialEndsAt }).from(b).where(eq(b.tenantId, id));
      if (!before) throw new NotFoundException('This business has no billing record');
      const graceEnd = new Date(Date.now() + 14 * 86_400_000);
      await tx
        .update(b)
        .set(
          body.free
            ? { freeSince: before.freeSince ?? new Date(), freeReason: body.reason! }
            : { freeSince: null, freeReason: null, ...(before.trialEndsAt < graceEnd ? { trialEndsAt: graceEnd } : {}) },
        )
        .where(eq(b.tenantId, id));
      await tx.insert(schema.auditLog).values({
        tenantId: id,
        actorUserId: admin.userId,
        action: body.free ? 'billing.made_free' : 'billing.free_ended',
        targetType: 'tenant',
        targetId: id,
        data: { by: 'Ample POS support', reason: body.reason ?? null },
      });
      await this.log(tx, admin, body.free ? 'company.made_free' : 'company.free_ended', id, { reason: body.reason ?? null });
      return this.companyDetail(tx, id);
    });
  }

  /** Makes a member the owner (e.g. the business was sold, or the owner left), optionally stepping the current owners down. */
  @Post('companies/:id/owner')
  @HttpCode(200)
  async setOwner(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ownerBody)) body: z.infer<typeof ownerBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const roles = await tx
        .select({ id: schema.roles.id, key: schema.roles.key, name: schema.roles.name })
        .from(schema.roles)
        .where(eq(schema.roles.tenantId, id));
      const owner = roles.find((r) => r.key === 'owner');
      if (!owner) throw new ConflictException('This business has no owner role');
      const m = schema.memberships;
      const [target] = await tx
        .select({ id: m.id, roleId: m.roleId })
        .from(m)
        .where(and(eq(m.tenantId, id), eq(m.userId, body.userId), eq(m.status, 'active')));
      if (!target) throw new BadRequestException('That person isn’t an active member of this business. Invite them first.');
      let stepDown: (typeof roles)[number] | null = null;
      if (body.previousOwnersBecome !== null) {
        stepDown = roles.find((r) => r.key === body.previousOwnersBecome || r.id === body.previousOwnersBecome) ?? null;
        if (!stepDown || stepDown.key === 'owner') throw new BadRequestException('Choose a role other than owner for the current owners');
      }
      await tx.update(m).set({ roleId: owner.id }).where(eq(m.id, target.id));
      const steppedDown = stepDown
        ? await tx
            .update(m)
            .set({ roleId: stepDown.id })
            .where(and(eq(m.tenantId, id), eq(m.roleId, owner.id), ne(m.id, target.id)))
            .returning({ userId: m.userId })
        : [];
      const data = { userId: body.userId, steppedDown: steppedDown.map((s) => s.userId), steppedDownTo: stepDown?.key ?? null };
      await this.tenantEvent(tx, id, admin, 'member.updated', { type: 'membership', id: target.id }, { ...data, role: 'owner' });
      await this.log(tx, admin, 'company.owner_changed', id, data);
      return this.companyDetail(tx, id);
    });
  }

  /** Plans and online store prices, as the pricing page and bills use them. */
  @Get('plans')
  async plans() {
    await this.access.require();
    return this.platform.run((tx) => this.planCatalog(tx));
  }

  @Put('plans/:planId')
  async setPlanPrices(@Param('planId') planId: string, @Body(new ZodPipe(planPriceBody)) body: z.infer<typeof planPriceBody>) {
    const admin = await this.access.require();
    if (!(PLAN_IDS as readonly string[]).includes(planId)) throw new NotFoundException('Unknown plan');
    return this.platform.run(async (tx) => {
      const set = { ...body, updatedAt: new Date(), updatedBy: admin.userId };
      await tx
        .insert(schema.platformPlans)
        .values({ planId, ...set })
        .onConflictDoUpdate({ target: schema.platformPlans.planId, set });
      // Every business on the plan re-syncs its subscription at the new prices.
      const on = await tx
        .select({ tenantId: schema.tenantBilling.tenantId })
        .from(schema.tenantBilling)
        .where(eq(schema.tenantBilling.plan, planId as (typeof PLAN_IDS)[number]));
      for (const t of on) await tx.insert(schema.outbox).values({ tenantId: t.tenantId, topic: 'billing.items_changed', payload: { planId } });
      await this.log(tx, admin, 'plan.prices_changed', null, { planId, ...body });
      return this.planCatalog(tx);
    });
  }

  @Put('website-addons/:addonId')
  async setAddonPrice(@Param('addonId') addonId: string, @Body(new ZodPipe(addonPriceBody)) body: z.infer<typeof addonPriceBody>) {
    const admin = await this.access.require();
    if (!(WEBSITE_ADDON_IDS as readonly string[]).includes(addonId)) throw new NotFoundException('Unknown add-on');
    return this.platform.run(async (tx) => {
      const set = { setupMinor: body.setupMinor, updatedAt: new Date(), updatedBy: admin.userId };
      await tx
        .insert(schema.platformWebsiteAddons)
        .values({ addonId, ...set })
        .onConflictDoUpdate({ target: schema.platformWebsiteAddons.addonId, set });
      await this.log(tx, admin, 'website_addon.price_changed', null, { addonId, ...body });
      return this.planCatalog(tx);
    });
  }

  /** Stops a business taking card payments (e.g. while a risk problem is looked at). It can set them up again. */
  @Post('companies/:id/card-payments/off')
  @HttpCode(200)
  async cardPaymentsOff(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(suspendBody)) body: z.infer<typeof suspendBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      await this.lockTenant(tx, id);
      const updated = await tx
        .update(schema.merchantAccounts)
        .set({ mode: 'off', updatedAt: new Date() })
        .where(eq(schema.merchantAccounts.tenantId, id))
        .returning({ tenantId: schema.merchantAccounts.tenantId });
      if (!updated.length) throw new ConflictException('This business hasn’t set up card payments');
      await this.tenantEvent(tx, id, admin, 'payments.merchant_off', { type: 'merchant', id }, { reason: body.reason });
      await this.log(tx, admin, 'company.card_payments_off', id, { reason: body.reason });
      return this.companyDetail(tx, id);
    });
  }

  /** A business's sales with how they were paid, newest first. */
  @Get('companies/:id/transactions')
  async transactions(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(transactionsQuery)) q: z.infer<typeof transactionsQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        receipt_number: string | null;
        status: string;
        total_minor: string;
        currency: string;
        created_at: Date;
        location: string;
        cashier: string | null;
        refunded: string;
        payments: { method: string; status: string; amountMinor: number }[] | null;
      }>(sql`
        select s.id, s.receipt_number, s.status, s.total_minor, s.currency, s.created_at, l.name as location, u.display_name as cashier,
               (select coalesce(sum(amount_minor), 0) from refunds r where r.sale_id = s.id) as refunded,
               (select json_agg(json_build_object('method', p.method, 'status', p.status, 'amountMinor', p.amount_minor) order by p.created_at)
                  from payments p where p.sale_id = s.id) as payments
        from sales s join locations l on l.id = s.location_id left join users u on u.id = s.created_by
        where s.tenant_id = ${id} ${q.before ? sql`and s.created_at < ${q.before}` : sql``}
        order by s.created_at desc limit ${q.limit}`);
      const list = rows.map((r) => ({
        id: r.id,
        receiptNumber: r.receipt_number === null ? null : n(r.receipt_number),
        status: r.status,
        totalMinor: n(r.total_minor),
        refundedMinor: n(r.refunded),
        currency: r.currency,
        createdAt: r.created_at,
        location: r.location,
        cashier: r.cashier,
        payments: r.payments ?? [],
      }));
      return { transactions: list, nextBefore: list.length === q.limit ? new Date(list.at(-1)!.createdAt).toISOString() : null };
    });
  }

  /** Everything businesses (and admins) did, across the platform or for one business. */
  @Get('activity')
  async activity(@Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const a = schema.auditLog;
      const rows = await tx
        .select({
          id: a.id,
          tenantId: a.tenantId,
          tenantName: schema.tenants.name,
          action: a.action,
          targetType: a.targetType,
          targetId: a.targetId,
          data: a.data,
          actor: schema.users.displayName,
          actorEmail: schema.users.email,
          createdAt: a.createdAt,
        })
        .from(a)
        .innerJoin(schema.tenants, eq(schema.tenants.id, a.tenantId))
        .leftJoin(schema.users, eq(schema.users.id, a.actorUserId))
        .where(and(q.tenantId ? eq(a.tenantId, q.tenantId) : undefined, q.before ? lt(a.id, q.before) : undefined))
        .orderBy(desc(a.id))
        .limit(q.limit);
      return { entries: rows, nextBefore: rows.length === q.limit ? rows.at(-1)!.id : null };
    });
  }

  /** Problems that need a look, worst first. */
  @Get('issues')
  async issues() {
    await this.access.require();
    return this.platform.run((tx) => this.findIssues(tx));
  }

  /** What platform admins changed. */
  @Get('audit')
  async audit(@Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const p = schema.platformAudit;
      return tx
        .select({
          id: p.id,
          action: p.action,
          tenantId: p.tenantId,
          tenantName: schema.tenants.name,
          data: p.data,
          actorEmail: schema.users.email,
          createdAt: p.createdAt,
        })
        .from(p)
        .leftJoin(schema.tenants, eq(schema.tenants.id, p.tenantId))
        .leftJoin(schema.users, eq(schema.users.id, p.actorUserId))
        .where(and(q.tenantId ? eq(p.tenantId, q.tenantId) : undefined, q.before ? lt(p.id, q.before) : undefined))
        .orderBy(desc(p.id))
        .limit(q.limit);
    });
  }

  /** Every tool with its platform-wide settings and how many businesses use it. */
  @Get('tools')
  async tools() {
    await this.access.require();
    return this.platform.run((tx) => this.toolCatalog(tx));
  }

  /** Switch a tool off for everyone (or back on), or change its monthly price. */
  @Put('tools/:moduleId')
  async setPlatformTool(@Param('moduleId') moduleId: string, @Body(new ZodPipe(platformToolBody)) body: z.infer<typeof platformToolBody>) {
    const admin = await this.access.require();
    if (!isModuleId(moduleId)) throw new NotFoundException(`Unknown tool: ${moduleId}`);
    return this.platform.run(async (tx) => {
      const [before] = await tx.select().from(schema.platformModules).where(eq(schema.platformModules.moduleId, moduleId)).for('update');
      const set = {
        ...(body.available !== undefined ? { available: body.available } : {}),
        ...(body.monthlyPriceMinor !== undefined ? { monthlyPriceMinor: body.monthlyPriceMinor } : {}),
        updatedAt: new Date(),
        updatedBy: admin.userId,
      };
      await tx
        .insert(schema.platformModules)
        .values({ moduleId, available: true, ...set })
        .onConflictDoUpdate({ target: schema.platformModules.moduleId, set });
      // Businesses using the tool re-sync their subscriptions (prices, or a tool no longer counted).
      const users = await tx
        .select({ tenantId: schema.tenantModules.tenantId })
        .from(schema.tenantModules)
        .where(and(eq(schema.tenantModules.moduleId, moduleId), eq(schema.tenantModules.enabled, true)));
      for (const u of users) await tx.insert(schema.outbox).values({ tenantId: u.tenantId, topic: 'billing.items_changed', payload: { moduleId } });
      await this.log(tx, admin, 'platform_tool.changed', null, {
        moduleId,
        from: { available: before?.available ?? true, monthlyPriceMinor: before?.monthlyPriceMinor ?? null },
        to: {
          available: body.available ?? before?.available ?? true,
          monthlyPriceMinor: body.monthlyPriceMinor !== undefined ? body.monthlyPriceMinor : (before?.monthlyPriceMinor ?? null),
        },
      });
      return this.toolCatalog(tx);
    });
  }

  // Internals ------------------------------------------------------------------

  private async lockTenant(tx: Transaction, id: string) {
    const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, id)).for('update');
    if (!t) throw new NotFoundException('Business not found');
  }

  private async tenantEvent(
    tx: Transaction,
    tenantId: string,
    admin: PlatformAdmin,
    action: string,
    target: { type: string; id: string },
    data: Record<string, unknown>,
  ) {
    const payload = { ...data, by: 'Ample POS support' };
    await tx.insert(schema.auditLog).values({ tenantId, actorUserId: admin.userId, action, targetType: target.type, targetId: target.id, data: payload });
    await tx.insert(schema.outbox).values({ tenantId, topic: action, payload: { [`${target.type}Id`]: target.id, ...payload } });
  }

  private async log(tx: Transaction, admin: PlatformAdmin, action: string, tenantId: string | null, data: Record<string, unknown>) {
    await tx.insert(schema.platformAudit).values({ actorUserId: admin.userId, action, tenantId, data });
  }

  private async planCatalog(tx: Transaction) {
    const [plans, addons] = await Promise.all([planSettings(tx), websiteAddonSettings(tx)]);
    const counts = new Map(
      (await tx.execute<{ plan: string; count: string }>(sql`select plan, count(*) as count from tenant_billing group by plan`)).map((r) => [
        r.plan,
        n(r.count),
      ]),
    );
    return {
      plans: [...plans.values()].map((p) => ({ ...p, companies: counts.get(p.id) ?? 0 })),
      websiteAddons: [...addons.values()],
    };
  }

  private async toolCatalog(tx: Transaction) {
    const settings = new Map((await tx.select().from(schema.platformModules)).map((r) => [r.moduleId, r]));
    const usage = await tx.execute<{ module_id: string; enabled: string; comped: string; blocked: string }>(sql`
      select module_id, count(*) filter (where enabled) as enabled, count(*) filter (where enabled and comped) as comped, count(*) filter (where blocked) as blocked
      from tenant_modules group by module_id`);
    const byId = new Map(usage.map((u) => [u.module_id, u]));
    return MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      dependsOn: m.dependsOn,
      builtInPriceMinor: m.monthlyPriceMinor,
      monthlyPriceMinor: settings.get(m.id)?.monthlyPriceMinor ?? m.monthlyPriceMinor,
      priceOverridden: settings.get(m.id)?.monthlyPriceMinor != null,
      available: settings.get(m.id)?.available ?? true,
      companiesUsing: n(byId.get(m.id)?.enabled),
      companiesComped: n(byId.get(m.id)?.comped),
      companiesBlocked: n(byId.get(m.id)?.blocked),
    }));
  }

  private async companyDetail(tx: Transaction, id: string) {
    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    if (!tenant) throw new NotFoundException('Business not found');
    const [billing] = await tx.select().from(schema.tenantBilling).where(eq(schema.tenantBilling.tenantId, id));
    // Only these columns are readable here; the business's keys never are.
    const ma = schema.merchantAccounts;
    const [merchant] = await tx
      .select({
        mode: ma.mode,
        connectAccountId: ma.connectAccountId,
        ownAccountId: ma.ownAccountId,
        chargesEnabled: ma.chargesEnabled,
        payoutsEnabled: ma.payoutsEnabled,
        detailsSubmitted: ma.detailsSubmitted,
        requirementsDue: ma.requirementsDue,
        disabledReason: ma.disabledReason,
        businessName: ma.businessName,
        livemode: ma.livemode,
        statusSyncedAt: ma.statusSyncedAt,
        updatedAt: ma.updatedAt,
      })
      .from(ma)
      .where(eq(ma.tenantId, id));
    const own = new Map((await tx.select().from(schema.tenantModules).where(eq(schema.tenantModules.tenantId, id))).map((r) => [r.moduleId, r]));
    const catalog = new Map((await this.toolCatalog(tx)).map((t) => [t.id, t]));
    const members = await tx.execute<{
      id: string;
      membership_id: string;
      name: string | null;
      email: string | null;
      role: string;
      role_key: string;
      status: string;
      last_seen_at: Date;
      joined_at: Date;
    }>(sql`
      select u.id, m.id as membership_id, u.display_name as name, u.email, r.name as role, r.key as role_key, m.status, u.last_seen_at, m.created_at as joined_at
      from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
      where m.tenant_id = ${id} order by m.created_at`);
    const locations = await tx
      .select({ id: schema.locations.id, name: schema.locations.name, timezone: schema.locations.timezone, archivedAt: schema.locations.archivedAt })
      .from(schema.locations)
      .where(eq(schema.locations.tenantId, id));
    const [stats] = await tx.execute<{ sales30: string; gross30: string; refunds30: string; devices: string; customers: string; products: string }>(sql`
      select (select count(*) from sales where tenant_id = ${id} and status = 'completed' and completed_at >= now() - interval '30 days') as sales30,
             (select coalesce(sum(total_minor), 0) from sales where tenant_id = ${id} and status = 'completed' and completed_at >= now() - interval '30 days') as gross30,
             (select coalesce(sum(amount_minor), 0) from refunds where tenant_id = ${id} and created_at >= now() - interval '30 days') as refunds30,
             (select count(*) from devices where tenant_id = ${id} and revoked_at is null) as devices,
             (select count(*) from customers where tenant_id = ${id}) as customers,
             (select count(*) from products where tenant_id = ${id}) as products`);
    const tenders = await tx.execute<{ method: string; amount: string }>(sql`
      select method, coalesce(sum(amount_minor), 0) as amount from payments
      where tenant_id = ${id} and status = 'succeeded' and created_at >= now() - interval '30 days' group by method`);
    const billingRow = billing
      ? {
          status: billing.status,
          trial_ends_at: billing.trialEndsAt,
          current_period_end: billing.currentPeriodEnd,
          cancel_at_period_end: billing.cancelAtPeriodEnd,
          items: billing.items,
          free_since: billing.freeSince,
        }
      : null;
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      currency: tenant.currency,
      createdAt: tenant.createdAt,
      suspendedAt: tenant.suspendedAt,
      suspendedReason: tenant.suspendedReason,
      billing: billing
        ? {
            standing: standingOf(billingRow),
            provider: billing.provider,
            status: billing.status,
            trialEndsAt: billing.trialEndsAt,
            currentPeriodEnd: billing.currentPeriodEnd,
            cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
            items: billing.items,
            mrrMinor: mrrOf(billingRow),
            plan: billing.plan,
            websiteAddon: billing.websiteAddon,
            websiteSetupChargedAt: billing.websiteSetupChargedAt,
            freeSince: billing.freeSince,
            freeReason: billing.freeReason,
          }
        : null,
      merchant: merchant ?? null,
      tools: MODULES.map((m) => {
        const row = own.get(m.id);
        const platform = catalog.get(m.id)!;
        return {
          id: m.id,
          name: m.name,
          dependsOn: m.dependsOn,
          enabled: row?.enabled ?? false,
          comped: row?.comped ?? false,
          blocked: row?.blocked ?? false,
          available: platform.available,
          monthlyPriceMinor: platform.monthlyPriceMinor,
        };
      }),
      members: members.map((m) => ({
        id: m.id,
        membershipId: m.membership_id,
        name: m.name,
        email: m.email,
        role: m.role,
        roleKey: m.role_key,
        status: m.status,
        lastSeenAt: m.last_seen_at,
        joinedAt: m.joined_at,
      })),
      roles: await tx.select({ id: schema.roles.id, key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.tenantId, id)),
      supportSessions: (
        await tx.execute<{
          id: string;
          email: string | null;
          reason: string;
          started_at: Date;
          expires_at: Date;
          ended_at: Date | null;
          admin_user_id: string;
        }>(sql`
          select s.id, u.email, s.reason, s.started_at, s.expires_at, s.ended_at, s.admin_user_id
          from platform_support_sessions s join users u on u.id = s.admin_user_id
          where s.tenant_id = ${id} order by s.started_at desc limit 10`)
      ).map((s) => ({
        id: s.id,
        adminUserId: s.admin_user_id,
        email: s.email,
        reason: s.reason,
        startedAt: s.started_at,
        expiresAt: s.expires_at,
        live: !s.ended_at && new Date(s.expires_at) > new Date(),
      })),
      locations,
      stats: {
        sales30: n(stats?.sales30),
        gross30Minor: n(stats?.gross30),
        refunds30Minor: n(stats?.refunds30),
        devices: n(stats?.devices),
        customers: n(stats?.customers),
        products: n(stats?.products),
        tenders30: Object.fromEntries(tenders.map((t) => [t.method, n(t.amount)])),
      },
      issues: (await this.findIssues(tx)).filter((i) => i.tenantId === id),
    };
  }

  /**
   * Problems worth a look, found from the data: failing subscriptions, card
   * payments failing or stuck, refunds that didn't go through, background
   * jobs that keep failing, and store connections in error.
   */
  private async findIssues(tx: Transaction): Promise<Issue[]> {
    const rows = await tx.execute<{
      key: string;
      tenant_id: string;
      tenant_name: string;
      severity: Severity;
      title: string;
      detail: string | null;
      since: Date;
    }>(sql`
      select * from (
        select 'billing:' || b.tenant_id as key, b.tenant_id, t.name as tenant_name, 'high' as severity,
               'Subscription payment failing' as title, 'Stripe status: ' || b.status as detail, b.updated_at as since
          from tenant_billing b join tenants t on t.id = b.tenant_id where b.status in ('past_due', 'unpaid')
        union all
        select 'trial:' || b.tenant_id, b.tenant_id, t.name, 'low', 'Trial ended without a subscription', 'Paid tools are read-only', b.trial_ends_at
          from tenant_billing b join tenants t on t.id = b.tenant_id
         where b.trial_ends_at < now() and (b.status is null or b.status not in ('active', 'trialing', 'past_due'))
           and exists (select 1 from tenant_modules tm where tm.tenant_id = b.tenant_id and tm.enabled and not tm.comped)
        union all
        select 'card-failed:' || p.tenant_id, p.tenant_id, t.name, 'medium', count(*) || case when count(*) = 1 then ' card payment' else ' card payments' end || ' failed in the last day', max(p.last_error), min(p.created_at)
          from payments p join tenants t on t.id = p.tenant_id
         where p.method = 'card' and p.status = 'failed' and p.created_at >= now() - interval '1 day'
         group by p.tenant_id, t.name having count(*) >= 3
        union all
        select 'card-stuck:' || p.tenant_id, p.tenant_id, t.name, 'high', count(*) || case when count(*) = 1 then ' card payment' else ' card payments' end || ' stuck waiting', 'Pending for over 30 minutes', min(p.created_at)
          from payments p join tenants t on t.id = p.tenant_id
         where p.method = 'card' and p.status = 'pending' and p.created_at < now() - interval '30 minutes'
         group by p.tenant_id, t.name
        union all
        select 'refund-failed:' || rp.tenant_id, rp.tenant_id, t.name, 'high', count(*) || case when count(*) = 1 then ' refund' else ' refunds' end || ' failed', null, min(r.created_at)
          from refund_payments rp join refunds r on r.id = rp.refund_id join tenants t on t.id = rp.tenant_id
         where rp.status = 'failed' and r.created_at >= now() - interval '14 days'
         group by rp.tenant_id, t.name
        union all
        select 'outbox:' || o.tenant_id || ':' || o.topic, o.tenant_id, t.name, 'high', 'Background job failing: ' || o.topic, max(o.last_error), min(o.created_at)
          from outbox o join tenants t on t.id = o.tenant_id
         where o.published_at is null and o.attempts >= 3
         group by o.tenant_id, t.name, o.topic
        union all
        select 'integration:' || c.id, c.tenant_id, t.name, 'high', 'Store connection in error (' || c.provider || ')', c.status_message, coalesce(c.orders_checked_at, c.created_at)
          from integration_connections c join tenants t on t.id = c.tenant_id where c.status = 'error'
        union all
        select 'sync-issues:' || s.tenant_id, s.tenant_id, t.name, 'medium', count(*) || case when count(*) = 1 then ' store sync problem' else ' store sync problems' end || ' to resolve', min(s.message), min(s.created_at)
          from sync_issues s join tenants t on t.id = s.tenant_id where s.resolved_at is null
         group by s.tenant_id, t.name
        union all
        select 'merchant:' || m.tenant_id, m.tenant_id, t.name, case when m.disabled_reason is not null then 'high' else 'medium' end,
               'Card payments not ready: Stripe needs information',
               coalesce('Stripe: ' || m.disabled_reason || '. ', '') || 'Due: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(m.requirements_due) x),
               coalesce(m.status_synced_at, m.updated_at)
          from merchant_accounts m join tenants t on t.id = m.tenant_id
         where m.mode = 'platform' and (not m.charges_enabled or jsonb_array_length(m.requirements_due) > 0)
        union all
        select 'register-open:' || r.id, r.tenant_id, t.name, 'low', 'Register open for over a day', l.name, r.opened_at
          from register_sessions r join tenants t on t.id = r.tenant_id join locations l on l.id = r.location_id
         where r.status = 'open' and r.opened_at < now() - interval '24 hours'
      ) i
      order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, since`);
    return rows.map((r) => ({
      key: r.key,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      since: new Date(r.since).toISOString(),
    }));
  }
}

import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { schema, type Transaction } from '@pos/db';
import { enabledDependents, getModule, isModuleId, missingDependencies, MODULES, type ModuleId } from '@pos/modules';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
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
  status: z.enum(['all', 'trial', 'active', 'past_due', 'lapsed', 'suspended']).default('all'),
});
const toolBody = z
  .object({ enabled: z.boolean().optional(), comped: z.boolean().optional(), blocked: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one setting');
const suspendBody = z.object({ reason: z.string().trim().min(1, 'Say why, so the business and other admins know').max(300) });
const pageQuery = z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), tenantId: z.string().uuid().optional() });
const transactionsQuery = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
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

type BillingRow = { status: string | null; trial_ends_at: Date | string; current_period_end: Date | string | null; cancel_at_period_end: boolean; items: { moduleId: string; quantity: number; unitMinor?: number }[] };

function standingOf(b: BillingRow | null | undefined): Standing | null {
  if (!b) return null;
  return standing({
    status: b.status,
    trialEndsAt: new Date(b.trial_ends_at),
    currentPeriodEnd: b.current_period_end ? new Date(b.current_period_end) : null,
    cancelAtPeriodEnd: b.cancel_at_period_end,
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
        select t.id, t.created_at, t.suspended_at, b.status, b.trial_ends_at, b.current_period_end, b.cancel_at_period_end, b.items
        from tenants t left join tenant_billing b on b.tenant_id = t.id`);
      const byStanding: Record<Standing, number> = { trial: 0, active: 0, past_due: 0, lapsed: 0 };
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
        { id: string; name: string; slug: string; created_at: Date; suspended_at: Date | null; suspended_reason: string | null; owner_email: string | null; tools: string; merchant: string | null; locations: string; members: string; sales30: string; gross30: string; last_activity: Date | null } & BillingRow
      >(sql`
        select t.id, t.name, t.slug, t.created_at, t.suspended_at, t.suspended_reason,
               b.status, b.trial_ends_at, b.current_period_end, b.cancel_at_period_end, b.items,
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
      const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.moduleId).filter(isModuleId));
      const next = {
        enabled: body.blocked ? false : (body.enabled ?? current?.enabled ?? false),
        comped: body.comped ?? current?.comped ?? false,
        blocked: body.blocked ?? current?.blocked ?? false,
      };
      if (next.enabled && !(current?.enabled ?? false)) {
        const missing = missingDependencies(moduleId, enabled);
        if (missing.length) throw new ConflictException({ code: 'missing_dependencies', message: `Turn on ${missing.map((m) => getModule(m).name).join(', ')} first` });
      }
      if (!next.enabled && (current?.enabled ?? false)) {
        const dependents = enabledDependents(moduleId, enabled);
        if (dependents.length) throw new ConflictException({ code: 'has_dependents', message: `Turn off ${dependents.map((m) => getModule(m).name).join(', ')} first` });
      }
      await tx
        .insert(schema.tenantModules)
        .values({ tenantId: id, moduleId, ...next, updatedBy: admin.userId })
        .onConflictDoUpdate({ target: [schema.tenantModules.tenantId, schema.tenantModules.moduleId], set: { ...next, updatedAt: new Date(), updatedBy: admin.userId } });
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
        .select({ id: p.id, action: p.action, tenantId: p.tenantId, tenantName: schema.tenants.name, data: p.data, actorEmail: schema.users.email, createdAt: p.createdAt })
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
        to: { available: body.available ?? before?.available ?? true, monthlyPriceMinor: body.monthlyPriceMinor !== undefined ? body.monthlyPriceMinor : (before?.monthlyPriceMinor ?? null) },
      });
      return this.toolCatalog(tx);
    });
  }

  // Internals ------------------------------------------------------------------

  private async lockTenant(tx: Transaction, id: string) {
    const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, id)).for('update');
    if (!t) throw new NotFoundException('Business not found');
  }

  private async tenantEvent(tx: Transaction, tenantId: string, admin: PlatformAdmin, action: string, target: { type: string; id: string }, data: Record<string, unknown>) {
    const payload = { ...data, by: 'Ample POS support' };
    await tx.insert(schema.auditLog).values({ tenantId, actorUserId: admin.userId, action, targetType: target.type, targetId: target.id, data: payload });
    await tx.insert(schema.outbox).values({ tenantId, topic: action, payload: { [`${target.type}Id`]: target.id, ...payload } });
  }

  private async log(tx: Transaction, admin: PlatformAdmin, action: string, tenantId: string | null, data: Record<string, unknown>) {
    await tx.insert(schema.platformAudit).values({ actorUserId: admin.userId, action, tenantId, data });
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
    const members = await tx.execute<{ id: string; name: string | null; email: string | null; role: string; status: string; last_seen_at: Date; joined_at: Date }>(sql`
      select u.id, u.display_name as name, u.email, r.name as role, m.status, u.last_seen_at, m.created_at as joined_at
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
      ? { status: billing.status, trial_ends_at: billing.trialEndsAt, current_period_end: billing.currentPeriodEnd, cancel_at_period_end: billing.cancelAtPeriodEnd, items: billing.items }
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
      members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, status: m.status, lastSeenAt: m.last_seen_at, joinedAt: m.joined_at })),
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
    const rows = await tx.execute<{ key: string; tenant_id: string; tenant_name: string; severity: Severity; title: string; detail: string | null; since: Date }>(sql`
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
    return rows.map((r) => ({ key: r.key, tenantId: r.tenant_id, tenantName: r.tenant_name, severity: r.severity, title: r.title, detail: r.detail, since: new Date(r.since).toISOString() }));
  }
}

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { schema, type Transaction } from '@pos/db';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newToken } from '../core/auth.service';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { NoTenant } from '../core/decorators';
import { Mailer } from '../core/mailer';
import { PlatformDb } from '../core/platform-db';
import { ZodPipe } from '../core/zod';
import { PlatformAccess, type PlatformAdmin } from './platform-access';

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'disabled', 'locked', 'unconfirmed']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const disableBody = z.object({ reason: z.string().trim().min(3, 'Say why, for the record').max(300) });

type AuthInfo = {
  user_id: string;
  has_password: boolean;
  email_verified: boolean;
  two_factor: boolean;
  locked_until: Date | null;
  live_sessions: number;
};

/**
 * People on the platform for the super admin: find anyone, see their
 * businesses and how they sign in, and help them (reset link, two-step reset,
 * confirm email) or turn the account off. Every action is in the platform audit.
 */
@Controller('platform/users')
@NoTenant()
export class PlatformPeopleController {
  private readonly logger = new Logger(PlatformPeopleController.name);

  constructor(
    private readonly access: PlatformAccess,
    private readonly platform: PlatformDb,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    await this.access.require();
    return this.platform.run(async (tx) => {
      const like = q.search ? `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      const rows = await tx.execute<{
        id: string;
        email: string | null;
        name: string | null;
        created_at: Date;
        last_seen_at: Date;
        disabled_at: Date | null;
        disabled_reason: string | null;
        businesses: string[] | null;
      }>(sql`
        select u.id, u.email, u.display_name as name, u.created_at, u.last_seen_at, u.disabled_at, u.disabled_reason,
               (select array_agg(t.name order by t.name) from memberships m join tenants t on t.id = m.tenant_id
                 where m.user_id = u.id and m.status = 'active') as businesses
        from users u
        where (${like}::text is null or u.email ilike ${like} or u.display_name ilike ${like}
               or exists (select 1 from memberships m join tenants t on t.id = m.tenant_id where m.user_id = u.id and t.name ilike ${like}))
          and (${q.status} <> 'disabled' or u.disabled_at is not null)
        order by u.last_seen_at desc
        limit ${q.status === 'all' || q.status === 'disabled' ? q.limit : 1000}`);
      const auth = await this.authInfo(
        tx,
        rows.map((r) => r.id),
      );
      return rows
        .map((r) => this.person(r, auth.get(r.id)))
        .filter((p) => (q.status === 'locked' ? p.locked : q.status === 'unconfirmed' ? p.hasPassword && !p.emailVerified : true))
        .slice(0, q.limit);
    });
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    await this.access.require();
    return this.platform.run((tx) => this.detail(tx, id));
  }

  /** A one-time link (24 hours) to choose a new password, emailed to them when email is set up, and shown here to pass on. */
  @Post(':id/password-reset')
  @HttpCode(200)
  async passwordReset(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const user = await this.find(tx, id);
      const { secret, secretHash } = newToken();
      const [row] = await tx.execute<{ id: string | null }>(sql`select app_admin_password_reset(${id}::uuid, ${secretHash}, ${admin.userId}::uuid) as id`);
      if (!row?.id) throw new ConflictException('This person hasn’t set a password yet (they sign in another way, or never finished signing up)');
      const link = `${this.config.WEB_URL}/reset?token=${row.id}.${secret}`;
      let emailed = false;
      if (this.mailer.enabled && user.email) {
        emailed = await this.mailer
          .send(
            user.email,
            'Reset your Ample POS password',
            `Ample POS support made a link for you to choose a new password.\n\nOpen it within 24 hours:\n${link}\n\nIf you didn’t ask for this, you can ignore this email; your password stays the same.`,
          )
          .then(() => true)
          .catch((err: Error) => {
            this.logger.error(err.message);
            return false;
          });
      }
      await this.log(tx, admin, 'user.password_reset_link', user, { emailed });
      return { link, emailed, expiresInHours: 24 };
    });
  }

  /** Turns off two-step sign-in, for someone who lost their phone and recovery codes. Their sessions end. */
  @Post(':id/two-factor/reset')
  @HttpCode(200)
  async resetTwoFactor(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const user = await this.find(tx, id);
      if (id === admin.userId) throw new BadRequestException('Change your own two-step sign-in in Your account');
      await tx.execute(sql`select app_two_factor_disable(${id}::uuid)`);
      await tx.execute(sql`select app_admin_end_sessions(${id}::uuid)`);
      await this.log(tx, admin, 'user.two_factor_reset', user, {});
      return this.detail(tx, id);
    });
  }

  @Post(':id/confirm-email')
  @HttpCode(200)
  async confirmEmail(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const user = await this.find(tx, id);
      const [row] = await tx.execute<{ changed: boolean }>(sql`select app_admin_confirm_user(${id}::uuid) as changed`);
      if (row?.changed) await this.log(tx, admin, 'user.email_confirmed', user, {});
      return this.detail(tx, id);
    });
  }

  /** Turns an account off: they can't sign in and their sessions end. Their businesses keep working for everyone else. */
  @Post(':id/disable')
  @HttpCode(200)
  async disable(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(disableBody)) body: z.infer<typeof disableBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const user = await this.find(tx, id);
      if (id === admin.userId) throw new BadRequestException('You can’t turn off your own account');
      if (user.email && this.config.PLATFORM_ADMIN_EMAILS.includes(user.email.toLowerCase())) {
        throw new BadRequestException('This is an Ample POS staff account. Remove it from PLATFORM_ADMIN_EMAILS first.');
      }
      await tx.execute(sql`select app_admin_set_disabled(${id}::uuid, ${body.reason})`);
      await this.log(tx, admin, 'user.disabled', user, { reason: body.reason });
      return this.detail(tx, id);
    });
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(@Param('id', ParseUUIDPipe) id: string) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const user = await this.find(tx, id);
      await tx.execute(sql`select app_admin_set_disabled(${id}::uuid, null)`);
      await this.log(tx, admin, 'user.enabled', user, {});
      return this.detail(tx, id);
    });
  }

  // Internals ------------------------------------------------------------------

  private async find(tx: Transaction, id: string) {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, id));
    if (!user) throw new NotFoundException('Person not found');
    return user;
  }

  private async detail(tx: Transaction, id: string) {
    const user = await this.find(tx, id);
    const auth = await this.authInfo(tx, [id]);
    const businesses = await tx.execute<{
      id: string;
      name: string;
      role: string;
      role_key: string;
      status: string;
      joined_at: Date;
      suspended_at: Date | null;
    }>(sql`
      select t.id, t.name, r.name as role, r.key as role_key, m.status, m.created_at as joined_at, t.suspended_at
      from memberships m join tenants t on t.id = m.tenant_id join roles r on r.id = m.role_id
      where m.user_id = ${id} order by t.name`);
    const history = await tx
      .select({ action: schema.platformAudit.action, data: schema.platformAudit.data, createdAt: schema.platformAudit.createdAt, by: schema.users.email })
      .from(schema.platformAudit)
      .leftJoin(schema.users, eq(schema.users.id, schema.platformAudit.actorUserId))
      .where(sql`${schema.platformAudit.data} ->> 'userId' = ${id}`)
      .orderBy(desc(schema.platformAudit.createdAt))
      .limit(20);
    return {
      ...this.person(
        {
          id: user.id,
          email: user.email,
          name: user.displayName,
          created_at: user.createdAt,
          last_seen_at: user.lastSeenAt,
          disabled_at: user.disabledAt,
          disabled_reason: user.disabledReason,
          businesses: businesses.filter((b) => b.status === 'active').map((b) => b.name),
        },
        auth.get(id),
      ),
      memberships: businesses.map((b) => ({
        tenantId: b.id,
        name: b.name,
        role: b.role,
        roleKey: b.role_key,
        status: b.status,
        joinedAt: b.joined_at,
        suspended: Boolean(b.suspended_at),
      })),
      history,
    };
  }

  private person(
    r: {
      id: string;
      email: string | null;
      name: string | null;
      created_at: Date;
      last_seen_at: Date;
      disabled_at: Date | null;
      disabled_reason: string | null;
      businesses: string[] | null;
    },
    a: AuthInfo | undefined,
  ) {
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      disabledAt: r.disabled_at,
      disabledReason: r.disabled_reason,
      businesses: r.businesses ?? [],
      platformAdmin: Boolean(r.email && this.config.PLATFORM_ADMIN_EMAILS.includes(r.email.toLowerCase())),
      hasPassword: a?.has_password ?? false,
      emailVerified: a?.email_verified ?? false,
      twoFactor: a?.two_factor ?? false,
      locked: Boolean(a?.locked_until && new Date(a.locked_until) > new Date()),
      liveSessions: a?.live_sessions ?? 0,
    };
  }

  private async authInfo(tx: Transaction, ids: string[]) {
    if (!ids.length) return new Map<string, AuthInfo>();
    const rows = await tx.execute<AuthInfo>(sql`select * from app_admin_user_auth(${`{${ids.join(',')}}`}::uuid[])`);
    return new Map(rows.map((r) => [r.user_id, r]));
  }

  private async log(tx: Transaction, admin: PlatformAdmin, action: string, user: { id: string; email: string | null }, data: Record<string, unknown>) {
    await tx.insert(schema.platformAudit).values({ actorUserId: admin.userId, action, tenantId: null, data: { userId: user.id, email: user.email, ...data } });
  }
}

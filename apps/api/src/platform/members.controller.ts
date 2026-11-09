import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertCanDelegate } from '../core/access';
import { newToken } from '../core/auth.service';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { ZodPipe } from '../core/zod';

const updateBody = z
  .object({
    roleId: z.string().uuid(),
    status: z.enum(['active', 'suspended']),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'provide at least one field');

@Controller('members')
export class MembersController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @RequirePermission('members.read')
  @Get()
  list() {
    return this.db.tx
      .select({
        id: schema.memberships.id,
        status: schema.memberships.status,
        createdAt: schema.memberships.createdAt,
        user: { id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName },
        role: { id: schema.roles.id, key: schema.roles.key, name: schema.roles.name },
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .orderBy(asc(schema.memberships.createdAt));
  }

  @RequirePermission('members.manage')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const tx = this.db.tx;
    const [member] = await tx
      .select({ id: schema.memberships.id, roleKey: schema.roles.key, permissions: schema.roles.permissions })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(eq(schema.memberships.id, id))
      .for('update');
    if (!member) throw new NotFoundException('Member not found');
    // You can only manage people whose access you already hold.
    assertCanDelegate(member.permissions);

    let newRoleKey = member.roleKey;
    if (body.roleId) {
      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.id, body.roleId));
      if (!role) throw new NotFoundException('Role not found');
      assertCanDelegate(role.permissions);
      newRoleKey = role.key;
    }

    const losesOwner = member.roleKey === 'owner' && (newRoleKey !== 'owner' || body.status === 'suspended');
    if (losesOwner) {
      const [others] = await tx
        .select({ n: count() })
        .from(schema.memberships)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
        .where(and(eq(schema.roles.key, 'owner'), eq(schema.memberships.status, 'active'), ne(schema.memberships.id, id)));
      if (others!.n === 0) throw new ConflictException('A business must keep at least one active owner');
    }

    const [updated] = await tx.update(schema.memberships).set(body).where(eq(schema.memberships.id, id)).returning();
    await this.events.record('member.updated', { type: 'membership', id }, body);
    return updated;
  }

  /**
   * A one-time link (valid 24 hours) that lets a member choose a new password,
   * for when they forgot theirs and email reset isn't available. Only for people
   * who belong to this business alone, so it can't open an account used elsewhere.
   */
  @RequirePermission('members.manage')
  @Post(':id/password-reset')
  async passwordReset(@Param('id', ParseUUIDPipe) id: string) {
    const tx = this.db.tx;
    const [member] = await tx
      .select({ userId: schema.memberships.userId, permissions: schema.roles.permissions })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(eq(schema.memberships.id, id));
    if (!member) throw new NotFoundException('Member not found');
    assertCanDelegate(member.permissions);

    const { secret, secretHash } = newToken();
    let resetId: string;
    try {
      const [row] = await tx.execute<{ id: string }>(sql`select app_create_member_reset(${member.userId}::uuid, ${secretHash}) as id`);
      resetId = row!.id;
    } catch (err) {
      const pgError = (err as { cause?: { code?: string; message?: string } }).cause ?? (err as { code?: string; message?: string });
      if (pgError.code === '22023') throw new ConflictException(pgError.message);
      throw err;
    }
    await this.events.audit('member.password_reset_link', { type: 'membership', id });
    return { link: `${this.config.WEB_URL}/reset?token=${resetId}.${secret}`, expiresInHours: 24 };
  }
}

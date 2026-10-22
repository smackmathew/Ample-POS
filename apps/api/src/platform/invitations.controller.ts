import { createHash, randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertCanDelegate } from '../core/access';
import { Db } from '../core/database';
import { NoTenant, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentContext, currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const createBody = z.object({
  roleId: z.string().uuid(),
  email: z.string().email().optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

const acceptBody = z.object({ code: z.string().min(10).max(200) });

const { codeHash: _codeHash, ...publicColumns } = getTableColumns(schema.invitations);

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @RequirePermission('members.manage')
  @Get()
  list() {
    return this.db.tx
      .select(publicColumns)
      .from(schema.invitations)
      .where(and(isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt)))
      .orderBy(desc(schema.invitations.createdAt));
  }

  /** Returns the invitation code once; only its hash is stored. */
  @RequirePermission('members.manage')
  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const [role] = await this.db.tx.select().from(schema.roles).where(eq(schema.roles.id, body.roleId));
    if (!role) throw new NotFoundException('Role not found');
    assertCanDelegate(role.permissions);

    const code = randomBytes(24).toString('base64url');
    const [invitation] = await this.db.tx
      .insert(schema.invitations)
      .values({
        tenantId: currentTenant().tenantId,
        roleId: role.id,
        email: body.email ?? null,
        codeHash: hashCode(code),
        createdBy: currentContext().user.userId,
        expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
      })
      .returning(publicColumns);
    await this.events.record('invitation.created', { type: 'invitation', id: invitation!.id }, {
      roleId: role.id,
      email: body.email ?? null,
    });
    return { invitation, code };
  }

  @RequirePermission('members.manage')
  @Post(':id/revoke')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    const [invitation] = await this.db.tx
      .update(schema.invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.invitations.id, id), isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt)))
      .returning(publicColumns);
    if (!invitation) throw new NotFoundException('Open invitation not found');
    await this.events.record('invitation.revoked', { type: 'invitation', id });
    return invitation;
  }

  @NoTenant()
  @Post('accept')
  async accept(@Body(new ZodPipe(acceptBody)) body: z.infer<typeof acceptBody>) {
    try {
      // Savepoint so a rejected code does not poison the request transaction.
      const [row] = await this.db.tx.transaction((sp) =>
        sp.execute<{ id: string }>(sql`select app_accept_invitation(${hashCode(body.code)}) as id`),
      );
      return { tenantId: row!.id };
    } catch (err) {
      const code = pgCode(err);
      if (code === 'P0002') throw new GoneException('This invitation is invalid or has expired');
      if (code === '42501') throw new ForbiddenException('This invitation was issued to a different email address');
      throw err;
    }
  }
}

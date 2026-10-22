import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { knownPermissionKeys } from '@pos/modules';
import { asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertCanDelegate } from '../core/access';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const permissions = z
  .array(z.string())
  .max(200)
  .transform((list) => [...new Set(list)].sort());

const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  permissions,
});

const updateBody = z
  .object({ name: z.string().trim().min(1).max(60), permissions })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'provide at least one field');

function assertKnown(list: string[]): void {
  const known = knownPermissionKeys();
  const unknown = list.filter((p) => !known.has(p));
  if (unknown.length) throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);
}

function keyFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `custom-${slug || 'role'}`;
}

@Controller('roles')
export class RolesController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @RequirePermission('members.read')
  @Get()
  list() {
    // Built-in roles share a creation timestamp, so order them explicitly.
    const rank = sql`case ${schema.roles.key} when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end`;
    return this.db.tx.select().from(schema.roles).orderBy(rank, asc(schema.roles.createdAt), asc(schema.roles.name));
  }

  @RequirePermission('roles.manage')
  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    assertKnown(body.permissions);
    assertCanDelegate(body.permissions);
    const [role] = await this.db.tx
      .insert(schema.roles)
      .values({ tenantId: currentTenant().tenantId, key: keyFromName(body.name), ...body })
      .returning();
    await this.events.record('role.created', { type: 'role', id: role!.id }, body);
    return role;
  }

  @RequirePermission('roles.manage')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const role = await this.find(id);
    if (role.key === 'owner') throw new ForbiddenException('The owner role cannot be changed');
    assertCanDelegate(role.permissions);
    if (body.permissions) {
      assertKnown(body.permissions);
      assertCanDelegate(body.permissions);
    }
    const [updated] = await this.db.tx.update(schema.roles).set(body).where(eq(schema.roles.id, id)).returning();
    await this.events.record('role.updated', { type: 'role', id }, body);
    return updated;
  }

  @RequirePermission('roles.manage')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const role = await this.find(id);
    if (role.isSystem) throw new ForbiddenException('Built-in roles cannot be deleted');
    const [usage] = await this.db.tx
      .select({ n: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.roleId, id));
    if (usage!.n > 0) throw new ConflictException('Reassign members before deleting this role');
    await this.db.tx.delete(schema.roles).where(eq(schema.roles.id, id));
    await this.events.record('role.deleted', { type: 'role', id }, { name: role.name });
    return { id, deleted: true };
  }

  private async find(id: string) {
    const [role] = await this.db.tx.select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }
}

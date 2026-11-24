import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission, knownPermissionKeys } from '@pos/modules';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { effectivePermissions, newApiKey } from '../core/api-keys';
import { Db } from '../core/database';
import { NoApiKey, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  /** Permission keys, or ['*'] for everything the creator may do. */
  permissions: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
  readOnly: z.boolean().default(false),
});

const renameBody = z.object({ name: z.string().trim().min(1).max(80) });

/**
 * API keys let another app (a business's own hub, an integration) use this API
 * for one business. Only a signed-in person can manage them: a key can't
 * create or reveal other keys.
 */
@Controller('api-keys')
@RequirePermission('api.manage')
export class ApiKeysController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @NoApiKey()
  @Get()
  async list() {
    const k = schema.apiKeys;
    const rows = await this.db.tx
      .select({
        id: k.id,
        name: k.name,
        hint: k.hint,
        permissions: k.permissions,
        readOnly: k.readOnly,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        createdBy: { id: schema.users.id, name: schema.users.displayName, email: schema.users.email },
      })
      .from(k)
      .innerJoin(schema.users, eq(schema.users.id, k.createdBy))
      .orderBy(desc(k.createdAt));
    return rows;
  }

  /** Returns the full key once; only a hash is kept. */
  @NoApiKey()
  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const known = knownPermissionKeys();
    const permissions = [...new Set(body.permissions)];
    if (permissions.includes('*') && permissions.length > 1) throw new BadRequestException('Use either everything (*) or a list of permissions');
    const unknown = permissions.filter((p) => p !== '*' && !known.has(p));
    if (unknown.length) throw new BadRequestException(`Unknown permission: ${unknown.join(', ')}`);
    // You can't hand a key more than you have yourself.
    const mine = currentTenant().permissions;
    const beyond = permissions.filter((p) => p !== '*' && !hasPermission(mine, p));
    if (beyond.length) throw new ForbiddenException(`You don’t have these permissions yourself: ${beyond.join(', ')}`);

    const created = newApiKey();
    await this.db.tx.insert(schema.apiKeys).values({
      id: created.id,
      tenantId: currentTenant().tenantId,
      name: body.name,
      hint: created.hint,
      secretHash: created.secretHash,
      permissions,
      readOnly: body.readOnly,
      createdBy: currentUserId(),
    });
    await this.events.audit('api_key.created', { type: 'api_key', id: created.id }, { name: body.name, permissions, readOnly: body.readOnly });
    return {
      id: created.id,
      name: body.name,
      key: created.key,
      hint: created.hint,
      permissions,
      readOnly: body.readOnly,
      effectivePermissions: effectivePermissions(permissions, mine),
    };
  }

  @NoApiKey()
  @Patch(':id')
  async rename(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(renameBody)) body: z.infer<typeof renameBody>) {
    const [row] = await this.db.tx.update(schema.apiKeys).set({ name: body.name }).where(eq(schema.apiKeys.id, id)).returning({ id: schema.apiKeys.id });
    if (!row) throw new NotFoundException('API key not found');
    return { id, name: body.name };
  }

  /** Stops the key working at once. Can't be undone; make a new key instead. */
  @NoApiKey()
  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.tx
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
      .returning({ id: schema.apiKeys.id, name: schema.apiKeys.name });
    if (!row) throw new NotFoundException('API key not found or already revoked');
    await this.events.audit('api_key.revoked', { type: 'api_key', id }, { name: row.name });
    return { revoked: true };
  }
}

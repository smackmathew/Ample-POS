import { Controller, Get, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { ZodPipe } from '../core/zod';

const query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('audit')
export class AuditController {
  constructor(private readonly db: Db) {}

  @RequirePermission('audit.read')
  @Get()
  async list(@Query(new ZodPipe(query)) q: z.infer<typeof query>) {
    const rows = await this.db.tx
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        targetType: schema.auditLog.targetType,
        targetId: schema.auditLog.targetId,
        data: schema.auditLog.data,
        createdAt: schema.auditLog.createdAt,
        actor: { id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName },
      })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
      .where(q.before ? lt(schema.auditLog.id, q.before) : undefined)
      .orderBy(desc(schema.auditLog.id))
      .limit(q.limit);
    return { entries: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
  }
}

import { Body, ConflictException, Controller, Get, NotFoundException, Param, Put } from '@nestjs/common';
import { schema } from '@pos/db';
import {
  enabledDependents,
  getModule,
  isModuleId,
  missingDependencies,
  MODULES,
  type ModuleId,
} from '@pos/modules';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentContext, currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const toggleBody = z.object({ enabled: z.boolean() });

export async function enabledModuleIds(db: Db): Promise<Set<ModuleId>> {
  const rows = await db.tx
    .select({ moduleId: schema.tenantModules.moduleId })
    .from(schema.tenantModules)
    .where(eq(schema.tenantModules.enabled, true));
  return new Set(rows.map((r) => r.moduleId).filter(isModuleId));
}

@Controller('modules')
export class ModulesController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get()
  async list() {
    const enabled = await enabledModuleIds(this.db);
    return MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      phase: m.phase,
      dependsOn: m.dependsOn,
      permissions: m.permissions,
      enabled: enabled.has(m.id),
      missingDependencies: missingDependencies(m.id, enabled),
    }));
  }

  @RequirePermission('modules.manage')
  @Put(':id')
  async toggle(@Param('id') id: string, @Body(new ZodPipe(toggleBody)) body: z.infer<typeof toggleBody>) {
    if (!isModuleId(id)) throw new NotFoundException(`Unknown module: ${id}`);
    const { tenantId } = currentTenant();
    const tx = this.db.tx;

    // Serialize module changes per business so concurrent toggles cannot break dependencies.
    await tx.execute(sql`select 1 from tenants where id = ${tenantId} for update`);
    const enabled = await enabledModuleIds(this.db);
    if (enabled.has(id) === body.enabled) return { id, enabled: body.enabled };

    if (body.enabled) {
      const missing = missingDependencies(id, enabled);
      if (missing.length) {
        throw new ConflictException({
          code: 'missing_dependencies',
          message: `Enable ${missing.map((m) => getModule(m).name).join(', ')} first`,
          modules: missing,
        });
      }
    } else {
      const dependents = enabledDependents(id, enabled);
      if (dependents.length) {
        throw new ConflictException({
          code: 'has_dependents',
          message: `Disable ${dependents.map((m) => getModule(m).name).join(', ')} first`,
          modules: dependents,
        });
      }
    }

    await tx
      .insert(schema.tenantModules)
      .values({ tenantId, moduleId: id, enabled: body.enabled, updatedBy: currentContext().user.userId })
      .onConflictDoUpdate({
        target: [schema.tenantModules.tenantId, schema.tenantModules.moduleId],
        set: { enabled: body.enabled, updatedAt: new Date(), updatedBy: currentContext().user.userId },
      });
    await this.events.record(body.enabled ? 'module.enabled' : 'module.disabled', { type: 'module', id });
    return { id, enabled: body.enabled };
  }
}

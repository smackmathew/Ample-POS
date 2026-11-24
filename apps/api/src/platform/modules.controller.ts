import { Body, ConflictException, Controller, Get, NotFoundException, Param, Put } from '@nestjs/common';
import { schema } from '@pos/db';
import {
  enabledDependents,
  getModule,
  isModuleId,
  missingDependencies,
  MODULES,
  type ModuleId,
  WEBSITE_TOOL,
} from '@pos/modules';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { enabledTools, toolSettings } from '../core/tool-settings';

const toggleBody = z.object({ enabled: z.boolean() });

/** Tools that are on for the current business (and not switched off platform-wide). */
export async function enabledModuleIds(db: Db): Promise<Set<ModuleId>> {
  return enabledTools(db.tx);
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
    const settings = await toolSettings(this.db.tx);
    const rows = await this.db.tx.select().from(schema.tenantModules);
    const own = new Map(rows.map((r) => [r.moduleId, r]));
    return MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      phase: m.phase,
      monthlyPriceMinor: settings.get(m.id)!.priceMinor,
      dependsOn: m.dependsOn,
      permissions: m.permissions,
      enabled: enabled.has(m.id),
      missingDependencies: missingDependencies(m.id, enabled),
      // Set by Ample POS: switched off for everyone, off for this business, or free here.
      available: settings.get(m.id)!.available,
      blocked: own.get(m.id)?.blocked ?? false,
      comped: own.get(m.id)?.comped ?? false,
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
      if (!(await toolSettings(tx)).get(id)!.available) {
        throw new ConflictException({ code: 'unavailable', message: `${getModule(id).name} is temporarily unavailable` });
      }
      const [own] = await tx.select({ blocked: schema.tenantModules.blocked }).from(schema.tenantModules).where(eq(schema.tenantModules.moduleId, id));
      if (id === WEBSITE_TOOL) {
        const [billing] = await tx.select({ addon: schema.tenantBilling.websiteAddon }).from(schema.tenantBilling);
        if (!billing?.addon) throw new ConflictException({ code: 'website_addon_required', message: 'Website sync comes with the online store add-on. Add it in Billing first.' });
      }
      if (own?.blocked) throw new ConflictException({ code: 'blocked', message: `${getModule(id).name} was turned off for this business by Ample POS support. Contact support to turn it back on.` });
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
      .values({ tenantId, moduleId: id, enabled: body.enabled, updatedBy: currentUserId() })
      .onConflictDoUpdate({
        target: [schema.tenantModules.tenantId, schema.tenantModules.moduleId],
        set: { enabled: body.enabled, updatedAt: new Date(), updatedBy: currentUserId() },
      });
    await this.events.record(body.enabled ? 'module.enabled' : 'module.disabled', { type: 'module', id });
    return { id, enabled: body.enabled };
  }
}

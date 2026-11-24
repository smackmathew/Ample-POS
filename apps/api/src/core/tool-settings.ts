import { schema } from '@pos/db';
import { getModule, isModuleId, MODULES, type ModuleId } from '@pos/modules';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '@pos/db';

export interface ToolSetting {
  /** False when a platform admin has switched the tool off for everyone. */
  available: boolean;
  /** Monthly price per location: the platform's override, or the built-in price. */
  priceMinor: number;
}

/** Every tool's platform-wide settings (the catalog in code, with any overrides from the super admin). */
export async function toolSettings(tx: Transaction): Promise<Map<ModuleId, ToolSetting>> {
  const rows = await tx.select().from(schema.platformModules);
  const byId = new Map(rows.map((r) => [r.moduleId, r]));
  return new Map(
    MODULES.map((m) => {
      const row = byId.get(m.id);
      return [m.id, { available: row?.available ?? true, priceMinor: row?.monthlyPriceMinor ?? m.monthlyPriceMinor }];
    }),
  );
}

export async function toolSetting(tx: Transaction, id: ModuleId): Promise<ToolSetting> {
  const [row] = await tx.select().from(schema.platformModules).where(eq(schema.platformModules.moduleId, id));
  return { available: row?.available ?? true, priceMinor: row?.monthlyPriceMinor ?? getModule(id).monthlyPriceMinor };
}

const available = sql`coalesce((select pm.available from platform_modules pm where pm.module_id = ${schema.tenantModules.moduleId}), true)`;

/** The current business's tools that are on and not switched off platform-wide. */
export async function enabledTools(tx: Transaction): Promise<Set<ModuleId>> {
  const rows = await tx
    .select({ moduleId: schema.tenantModules.moduleId })
    .from(schema.tenantModules)
    .where(and(eq(schema.tenantModules.enabled, true), sql`${available}`));
  return new Set(rows.map((r) => r.moduleId).filter(isModuleId));
}

/** Of those, the ones a platform admin made free for this business. */
export async function compedTools(tx: Transaction): Promise<Set<ModuleId>> {
  const rows = await tx
    .select({ moduleId: schema.tenantModules.moduleId })
    .from(schema.tenantModules)
    .where(and(eq(schema.tenantModules.enabled, true), eq(schema.tenantModules.comped, true)));
  return new Set(rows.map((r) => r.moduleId).filter(isModuleId));
}

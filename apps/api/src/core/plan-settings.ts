import { schema, type Transaction } from '@pos/db';
import { PLANS, WEBSITE_ADDONS, type PlanDefinition, type PlanId, type WebsiteAddonDefinition, type WebsiteAddonId } from '@pos/modules';

/** Plans with any prices the super admin changed. */
export async function planSettings(tx: Transaction): Promise<Map<PlanId, PlanDefinition>> {
  const rows = new Map((await tx.select().from(schema.platformPlans)).map((r) => [r.planId, r]));
  return new Map(
    PLANS.map((p) => {
      const r = rows.get(p.id);
      return [
        p.id,
        {
          ...p,
          baseMinor: r?.baseMinor ?? p.baseMinor,
          extraLocationMinor: r?.extraLocationMinor ?? p.extraLocationMinor,
          registersPerLocation: r?.registersPerLocation ?? p.registersPerLocation,
          websiteMaintenanceMinor: r?.websiteMaintenanceMinor ?? p.websiteMaintenanceMinor,
        },
      ];
    }),
  );
}

export async function websiteAddonSettings(tx: Transaction): Promise<Map<WebsiteAddonId, WebsiteAddonDefinition>> {
  const rows = new Map((await tx.select().from(schema.platformWebsiteAddons)).map((r) => [r.addonId, r]));
  return new Map(WEBSITE_ADDONS.map((a) => [a.id, { ...a, setupMinor: rows.get(a.id)?.setupMinor ?? a.setupMinor }]));
}

/** Names for what appears on a bill besides tools. */
export function billLineName(key: string, plans: Map<PlanId, PlanDefinition>): string | null {
  const plan = /^plan:([a-z]+)(:location)?$/.exec(key);
  if (plan) {
    const p = plans.get(plan[1] as PlanId);
    if (!p) return null;
    return plan[2] ? `Extra locations (${p.name})` : `${p.name} plan, first location`;
  }
  if (key === 'website:maintenance') return 'Online store sync';
  return null;
}

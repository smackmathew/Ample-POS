import type { ModuleId } from './registry';

export const PLAN_IDS = ['starter', 'growth', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price for the first location. */
  baseMinor: number;
  /** Monthly price for each location after the first. */
  extraLocationMinor: number;
  /** Registers that can be open at once at each location. */
  registersPerLocation: number;
  /** Monthly fee for keeping an online store in sync, when the business has one. */
  websiteMaintenanceMinor: number;
}

/**
 * The plans businesses subscribe to. Every plan includes the point of sale,
 * product catalog, reports, customers and loyalty; other tools are add-ons at
 * their own prices. Prices here are the defaults; the super admin can change
 * them (platform_plans).
 */
export const PLANS: readonly PlanDefinition[] = [
  { id: 'starter', name: 'Starter', tagline: 'One register per store', baseMinor: 3900, extraLocationMinor: 1900, registersPerLocation: 1, websiteMaintenanceMinor: 999 },
  { id: 'growth', name: 'Growth', tagline: 'Up to 5 registers per store', baseMinor: 5900, extraLocationMinor: 2900, registersPerLocation: 5, websiteMaintenanceMinor: 1499 },
  { id: 'pro', name: 'Pro', tagline: 'Up to 10 registers per store', baseMinor: 7900, extraLocationMinor: 3900, registersPerLocation: 10, websiteMaintenanceMinor: 1999 },
];

export const WEBSITE_ADDON_IDS = ['simple', 'complex'] as const;
export type WebsiteAddonId = (typeof WEBSITE_ADDON_IDS)[number];

export interface WebsiteAddonDefinition {
  id: WebsiteAddonId;
  name: string;
  description: string;
  /** Charged once, when the add-on is first bought. */
  setupMinor: number;
}

/** An online store synced with in-store sales and stock: a one-time setup, then the plan's monthly sync fee. */
export const WEBSITE_ADDONS: readonly WebsiteAddonDefinition[] = [
  { id: 'simple', name: 'Online store', description: 'A ready-made online store synced with your in-store products, prices and stock.', setupMinor: 39900 },
  { id: 'complex', name: 'Custom online store', description: 'A custom-designed online store with more pages and features, synced the same way.', setupMinor: 59900 },
];

/** Tools every plan includes (shown on the pricing page). */
export const INCLUDED_TOOLS: readonly ModuleId[] = ['catalog', 'pos', 'reporting', 'customers', 'loyalty'];

/** The online-store sync tool comes with the website add-on rather than on its own. */
export const WEBSITE_TOOL: ModuleId = 'ecommerce-sync';

export const isPlanId = (v: string): v is PlanId => (PLAN_IDS as readonly string[]).includes(v);
export const isWebsiteAddonId = (v: string): v is WebsiteAddonId => (WEBSITE_ADDON_IDS as readonly string[]).includes(v);
export const getPlan = (id: PlanId): PlanDefinition => PLANS.find((p) => p.id === id)!;
export const getWebsiteAddon = (id: WebsiteAddonId): WebsiteAddonDefinition => WEBSITE_ADDONS.find((a) => a.id === id)!;

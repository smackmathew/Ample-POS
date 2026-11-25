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
  { id: 'growth', name: 'Growth', tagline: 'Up to 5 registers per store', baseMinor: 5900, extraLocationMinor: 2900, registersPerLocation: 5, websiteMaintenanceMinor: 999 },
  { id: 'pro', name: 'Pro', tagline: 'Up to 10 registers per store', baseMinor: 7900, extraLocationMinor: 3900, registersPerLocation: 10, websiteMaintenanceMinor: 999 },
];

export const WEBSITE_ADDON_IDS = ['sync', 'simple', 'complex'] as const;
export type WebsiteAddonId = (typeof WEBSITE_ADDON_IDS)[number];

export interface WebsiteAddonDefinition {
  id: WebsiteAddonId;
  name: string;
  description: string;
  /** Charged once, when the add-on is first bought. */
  setupMinor: number;
}

/**
 * Website options, each with the plan's monthly sync fee: sync an existing
 * website (no setup fee), or have us build a simple online store or a
 * multi-page website (a one-time setup fee).
 */
export const WEBSITE_ADDONS: readonly WebsiteAddonDefinition[] = [
  { id: 'sync', name: 'Website sync', description: 'Keep the website you already have (WordPress, Shopify or other) in sync with your POS: products, prices and stock.', setupMinor: 0 },
  { id: 'simple', name: 'Online store', description: 'A simple online store set up for you, synced with your POS.', setupMinor: 39900 },
  { id: 'complex', name: 'Website + online store', description: 'A multi-page website with your products, set up for you and synced with your POS.', setupMinor: 59900 },
];

/** Tools every plan includes (shown on the pricing page). */
export const INCLUDED_TOOLS: readonly ModuleId[] = ['catalog', 'pos', 'reporting', 'customers', 'loyalty'];

/** The online-store sync tool comes with the website add-on rather than on its own. */
export const WEBSITE_TOOL: ModuleId = 'ecommerce-sync';

export const isPlanId = (v: string): v is PlanId => (PLAN_IDS as readonly string[]).includes(v);
export const isWebsiteAddonId = (v: string): v is WebsiteAddonId => (WEBSITE_ADDON_IDS as readonly string[]).includes(v);
export const getPlan = (id: PlanId): PlanDefinition => PLANS.find((p) => p.id === id)!;
export const getWebsiteAddon = (id: WebsiteAddonId): WebsiteAddonDefinition => WEBSITE_ADDONS.find((a) => a.id === id)!;

import 'server-only';
import { cookies } from 'next/headers';
import { api, TOKEN_COOKIE } from './api';

export type PlanId = 'starter' | 'growth' | 'pro';
export type WebsiteAddonId = 'simple' | 'complex';

export interface PublicPricing {
  trialDays: number;
  plans: { id: PlanId; name: string; tagline: string; baseMinor: number; extraLocationMinor: number; registersPerLocation: number; websiteMaintenanceMinor: number }[];
  websiteAddons: { id: WebsiteAddonId; name: string; description: string; setupMinor: number }[];
  tools: { id: string; name: string; description: string; included: boolean; withOnlineStore: boolean; monthlyPriceMinor: number }[];
}

export const getPricing = () => api<PublicPricing>('/public/pricing', { anonymous: true });

export async function signedIn(): Promise<boolean> {
  return Boolean((await cookies()).get(TOKEN_COOKIE));
}

/** "$39" for whole dollars, "$9.99" otherwise. */
export function price(minor: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

export const isPlanId = (v: unknown): v is PlanId => v === 'starter' || v === 'growth' || v === 'pro';
export const isWebsiteAddonId = (v: unknown): v is WebsiteAddonId => v === 'simple' || v === 'complex';

/** What the visitor chose at signup, kept while they confirm their email. */
export interface PendingSetup {
  business: string;
  plan: PlanId;
  website: WebsiteAddonId | null;
  subscribe: boolean;
}

export const SETUP_COOKIE = 'pos_setup';

export async function readPendingSetup(): Promise<PendingSetup | null> {
  const raw = (await cookies()).get(SETUP_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as PendingSetup;
    return typeof v.business === 'string' && v.business && isPlanId(v.plan) ? { ...v, website: isWebsiteAddonId(v.website) ? v.website : null } : null;
  } catch {
    return null;
  }
}

export type Standing = 'trial' | 'active' | 'past_due' | 'lapsed';
export type Severity = 'high' | 'medium' | 'low';

export interface PlatformAccess {
  admin: boolean;
  email?: string;
  code?: string;
  message?: string;
}

export interface Issue {
  key: string;
  tenantId: string;
  tenantName: string;
  severity: Severity;
  title: string;
  detail: string | null;
  since: string;
}

export interface Overview {
  days: number;
  companies: { total: number; new: number; suspended: number; byStanding: Record<Standing, number> };
  mrrMinor: number;
  sales: { count: number; grossMinor: number; refundsMinor: number };
  daily: { date: string; sales: number; grossMinor: number; signups: number }[];
  tenders: Record<string, number>;
  topCompanies: { id: string; name: string; grossMinor: number; sales: number }[];
  users: { activeLast7Days: number; total: number };
  issues: { total: number; high: number };
  /** Companies by card setup: platform, pending (onboarding), own, off. */
  merchants: Record<string, number>;
  plans: Record<string, number>;
  websites: number;
}

export interface PlanCatalog {
  plans: {
    id: 'starter' | 'growth' | 'pro';
    name: string;
    tagline: string;
    baseMinor: number;
    extraLocationMinor: number;
    registersPerLocation: number;
    websiteMaintenanceMinor: number;
    companies: number;
  }[];
  websiteAddons: { id: 'sync' | 'simple' | 'complex'; name: string; description: string; setupMinor: number }[];
}

export const PLAN_NAME: Record<string, string> = { starter: 'Starter', growth: 'Growth', pro: 'Pro' };

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  ownerEmail: string | null;
  standing: Standing | null;
  trialEndsAt: string | null;
  mrrMinor: number;
  toolsOn: number;
  plan: 'starter' | 'growth' | 'pro' | null;
  websiteAddon: 'sync' | 'simple' | 'complex' | null;
  merchant: 'off' | 'platform' | 'platform:pending' | 'own';
  locations: number;
  members: number;
  sales30: number;
  gross30Minor: number;
  lastActivityAt: string | null;
  issues: number;
}

export interface CompanyTool {
  id: string;
  name: string;
  dependsOn: string[];
  enabled: boolean;
  comped: boolean;
  blocked: boolean;
  available: boolean;
  monthlyPriceMinor: number;
}

export interface Company {
  id: string;
  name: string;
  slug: string;
  currency: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  billing: {
    standing: Standing | null;
    provider: string | null;
    status: string | null;
    trialEndsAt: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    items: { moduleId: string; quantity: number; unitMinor?: number }[];
    mrrMinor: number;
    plan: 'starter' | 'growth' | 'pro';
    websiteAddon: 'sync' | 'simple' | 'complex' | null;
    websiteSetupChargedAt: string | null;
  } | null;
  tools: CompanyTool[];
  merchant: {
    mode: 'off' | 'platform' | 'own';
    connectAccountId: string | null;
    ownAccountId: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirementsDue: string[];
    disabledReason: string | null;
    businessName: string | null;
    livemode: boolean | null;
    statusSyncedAt: string | null;
    updatedAt: string;
  } | null;
  members: {
    id: string;
    membershipId: string;
    name: string | null;
    email: string | null;
    role: string;
    roleKey: string;
    status: string;
    lastSeenAt: string;
    joinedAt: string;
  }[];
  roles: { id: string; key: string; name: string }[];
  supportSessions: { id: string; adminUserId: string; email: string | null; reason: string; startedAt: string; expiresAt: string; live: boolean }[];
  locations: { id: string; name: string; timezone: string; archivedAt: string | null }[];
  stats: {
    sales30: number;
    gross30Minor: number;
    refunds30Minor: number;
    devices: number;
    customers: number;
    products: number;
    tenders30: Record<string, number>;
  };
  issues: Issue[];
}

export interface Transaction {
  id: string;
  receiptNumber: number | null;
  status: string;
  totalMinor: number;
  refundedMinor: number;
  currency: string;
  createdAt: string;
  location: string;
  cashier: string | null;
  payments: { method: string; status: string; amountMinor: number }[];
}

export interface ActivityEntry {
  id: number;
  tenantId: string;
  tenantName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  actor: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export interface PlatformTool {
  id: string;
  name: string;
  description: string;
  dependsOn: string[];
  builtInPriceMinor: number;
  monthlyPriceMinor: number;
  priceOverridden: boolean;
  available: boolean;
  companiesUsing: number;
  companiesComped: number;
  companiesBlocked: number;
}

export interface AdminLogEntry {
  id: number;
  action: string;
  tenantId: string | null;
  tenantName: string | null;
  data: Record<string, unknown>;
  actorEmail: string | null;
  createdAt: string;
}

export const STANDING: Record<Standing, [string, string]> = {
  trial: ['Trial', 'bg-sky-50 text-sky-800'],
  active: ['Subscribed', 'bg-teal-50 text-teal-800'],
  past_due: ['Payment failing', 'bg-red-50 text-red-800'],
  lapsed: ['Trial ended', 'bg-amber-50 text-amber-800'],
};

export const SEVERITY: Record<Severity, string> = {
  high: 'bg-red-50 text-red-800',
  medium: 'bg-amber-50 text-amber-800',
  low: 'bg-stone-100 text-stone-700',
};

export const MERCHANT: Record<string, [string, string]> = {
  off: ['No cards', 'text-stone-400'],
  platform: ['Built-in', 'text-teal-700'],
  'platform:pending': ['Built-in, onboarding', 'text-amber-700'],
  own: ['Own Stripe', 'text-sky-700'],
};

export const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', gift_card: 'Gift card' };

/** Platform times in UTC, so every admin reads the same time. */
export function utc(iso: string | Date, withTime = true): string {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    }).format(new Date(iso)) + (withTime ? ' UTC' : '')
  );
}

export const usd = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);

export interface Person {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  lastSeenAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  businesses: string[];
  platformAdmin: boolean;
  hasPassword: boolean;
  emailVerified: boolean;
  twoFactor: boolean;
  locked: boolean;
  liveSessions: number;
}

export interface PersonDetail extends Person {
  memberships: { tenantId: string; name: string; role: string; roleKey: string; status: string; joinedAt: string; suspended: boolean }[];
  history: { action: string; data: Record<string, unknown>; createdAt: string; by: string | null }[];
}

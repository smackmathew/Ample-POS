export interface Me {
  user: { id: string; email: string | null; displayName: string | null };
  tenants: { id: string; name: string; slug: string; role: { key: string; name: string } }[];
}

export interface CurrentTenant {
  tenant: { id: string; name: string; slug: string; currency: string };
  membership: { id: string; role: { id: string; key: string }; permissions: string[] };
  enabledModules: string[];
  billing: TenantBilling | null;
}

export type BillingStanding = 'trial' | 'active' | 'past_due' | 'lapsed';

export interface TenantBilling {
  standing: BillingStanding;
  trialEndsAt: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}

export interface BillingSummary {
  standing: BillingStanding;
  trialEndsAt: string;
  provider: 'simulated' | 'stripe';
  canManageOnline: boolean;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; syncedAt: string | null } | null;
  lines: { moduleId: string; name: string; unitMinor: number; quantity: number; totalMinor: number }[];
  included: string[];
  monthlyTotalMinor: number;
  currency: string;
}

export interface NavSection {
  title: string;
  moduleId?: string;
  items: { label: string; path: string }[];
}

export interface ModuleSummary {
  id: string;
  name: string;
  description: string;
  phase: number;
  monthlyPriceMinor: number;
  dependsOn: string[];
  permissions: { key: string; description: string }[];
  enabled: boolean;
  missingDependencies: string[];
}

export interface Location {
  id: string;
  name: string;
  kind: 'store' | 'warehouse' | 'office';
  timezone: string;
  taxRateBps: number;
  archivedAt: string | null;
}

export interface Device {
  id: string;
  locationId: string;
  name: string;
  kind: string;
  status: 'active' | 'revoked';
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
}

export interface Member {
  id: string;
  status: 'active' | 'suspended';
  user: { id: string; email: string | null; displayName: string | null };
  role: { id: string; key: string; name: string };
}

export interface AuditEntry {
  id: number;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  actor: { email: string | null; displayName: string | null } | null;
}

export const can = (permissions: string[], key: string) => permissions.includes('*') || permissions.includes(key);

export interface Variant {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  priceMinor: number;
  costMinor: number | null;
  trackInventory: boolean;
  status: 'active' | 'archived';
  version: number;
  barcodes: string[];
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  status: 'active' | 'archived';
  version: number;
  variants: Variant[];
}

export interface StockLevel {
  variantId: string;
  variantName: string;
  sku: string | null;
  productId: string;
  productName: string;
  onHand: number;
}

export interface Movement {
  id: number;
  locationName: string;
  variantName: string;
  productName: string;
  quantityDelta: number;
  reason: string;
  note: string | null;
  occurredAt: string;
  actor: { email: string | null; displayName: string | null } | null;
}

export interface CountSummary {
  id: string;
  name: string;
  status: 'open' | 'submitted' | 'approved' | 'cancelled';
  locationName: string;
  startedAt: string;
  entryCount: number;
}

export interface CountLine {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  counted: number;
  countedAt: string;
  expected: number;
  discrepancy: number;
  onHandNow: number;
}

export interface CountDetail {
  id: string;
  name: string;
  status: CountSummary['status'];
  locationId: string;
  startedAt: string;
  lines: CountLine[];
  totals: { items: number; withDiscrepancy: number; netUnits: number };
}

export interface CountEntry {
  id: string;
  variantName: string;
  productName: string;
  quantity: number;
  countedAt: string;
  voidedAt: string | null;
  countedBy: { email: string | null; displayName: string | null } | null;
}

export const variantLabel = (productName: string, variantName: string) =>
  variantName === 'Default' ? productName : `${productName} — ${variantName}`;

export interface RegisterSummary {
  id: string;
  locationId: string;
  locationName: string;
  deviceId: string | null;
  status: 'open' | 'closed';
  openingFloatMinor: number;
  openedAt: string;
  closedAt: string | null;
  countedCashMinor: number | null;
  totals: { salesCount: number; grossMinor: number; cashMinor: number; cardMinor: number; cashRefundsMinor: number; expectedCashMinor: number | null };
  varianceMinor: number | null;
}

export interface SaleLine {
  id: string;
  variantId: string;
  description: string;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  refundedQuantity: number;
  refundedMinor: number;
}

export interface SalePayment {
  id: string;
  method: 'cash' | 'card';
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  amountMinor: number;
  tenderedMinor: number | null;
  changeMinor: number | null;
  provider: string | null;
  lastError: string | null;
}

export interface Sale {
  id: string;
  status: 'open' | 'completed' | 'voided';
  currency: string;
  registerSessionId: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxRateBps: number;
  receiptNumber: number | null;
  createdAt: string;
  completedAt: string | null;
  lines: SaleLine[];
  payments: SalePayment[];
  refunds: { id: string; amountMinor: number; restock: boolean; reason: string | null; createdAt: string }[];
  paidMinor: number;
  pendingMinor: number;
  dueMinor: number;
  refundedMinor: number;
}

export interface SaleSummary {
  id: string;
  status: Sale['status'];
  receiptNumber: number | null;
  totalMinor: number;
  currency: string;
  createdAt: string;
  locationName: string;
  cashier: string | null;
  cashierEmail: string | null;
  refundedMinor: number;
}

// Drizzle table definitions mirroring migrations/*.sql. The SQL files are the
// source of truth (they also carry RLS policies and grants); keep these in step.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  currency: text('currency').notNull().default('USD'),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  authSubject: text('auth_subject').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  permissions: text('permissions').array().notNull().default(sql`'{}'`),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
  createdAt: createdAt(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['store', 'warehouse', 'office'] }).notNull().default('store'),
  timezone: text('timezone').notNull(),
  taxRateBps: integer('tax_rate_bps').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['register', 'handheld', 'kiosk'] }).notNull(),
  status: text('status', { enum: ['active', 'revoked'] }).notNull().default('active'),
  secretHash: text('secret_hash').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const tenantModules = pgTable(
  'tenant_modules',
  {
    tenantId: uuid('tenant_id').notNull(),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.moduleId] })],
);

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  actorDeviceId: uuid('actor_device_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const outbox = pgTable('outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  topic: text('topic').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  roleId: uuid('role_id').notNull(),
  email: text('email'),
  codeHash: text('code_hash').notNull().unique(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedBy: uuid('accepted_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  productId: uuid('product_id').notNull(),
  name: text('name').notNull().default('Default'),
  sku: text('sku'),
  priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  costMinor: bigint('cost_minor', { mode: 'number' }),
  trackInventory: boolean('track_inventory').notNull().default(true),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const variantBarcodes = pgTable(
  'variant_barcodes',
  {
    tenantId: uuid('tenant_id').notNull(),
    barcode: text('barcode').notNull(),
    variantId: uuid('variant_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.barcode] })],
);

export const MOVEMENT_REASONS = [
  'receive',
  'sale',
  'return',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'count_adjustment',
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

export const inventoryOperations = pgTable('inventory_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['receipt', 'adjustment', 'transfer', 'count', 'sale', 'refund'] }).notNull(),
  idempotencyKey: text('idempotency_key'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const stockMovements = pgTable('stock_movements', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantityDelta: integer('quantity_delta').notNull(),
  reason: text('reason', { enum: MOVEMENT_REASONS }).notNull(),
  operationId: uuid('operation_id').notNull(),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  note: text('note'),
  actorUserId: uuid('actor_user_id'),
  actorDeviceId: uuid('actor_device_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const stockLevels = pgTable(
  'stock_levels',
  {
    tenantId: uuid('tenant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    onHand: integer('on_hand').notNull(),
    lastMovementId: bigint('last_movement_id', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.locationId, t.variantId] })],
);

export const countSessions = pgTable('count_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['open', 'submitted', 'approved', 'cancelled'] }).notNull().default('open'),
  startedBy: uuid('started_by').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  submittedBy: uuid('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  operationId: uuid('operation_id'),
});

export const countEntries = pgTable('count_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: integer('quantity').notNull(),
  countedAt: timestamp('counted_at', { withTimezone: true }).notNull(),
  countedBy: uuid('counted_by').notNull(),
  deviceId: uuid('device_id'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by'),
  createdAt: createdAt(),
});

const money = (name: string) => bigint(name, { mode: 'number' });

export const tenantCounters = pgTable(
  'tenant_counters',
  {
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

export const registerSessions = pgTable('register_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  deviceId: uuid('device_id'),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  openingFloatMinor: money('opening_float_minor').notNull(),
  openedBy: uuid('opened_by').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  countedCashMinor: money('counted_cash_minor'),
  expectedCashMinor: money('expected_cash_minor'),
  closedBy: uuid('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const sales = pgTable('sales', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  locationId: uuid('location_id').notNull(),
  registerSessionId: uuid('register_session_id').notNull(),
  deviceId: uuid('device_id'),
  status: text('status', { enum: ['open', 'completed', 'voided'] }).notNull().default('open'),
  currency: text('currency').notNull(),
  subtotalMinor: money('subtotal_minor').notNull(),
  discountMinor: money('discount_minor').notNull(),
  taxMinor: money('tax_minor').notNull(),
  totalMinor: money('total_minor').notNull(),
  taxRateBps: integer('tax_rate_bps').notNull(),
  receiptNumber: bigint('receipt_number', { mode: 'number' }),
  note: text('note'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
});

export const saleLines = pgTable('sale_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  saleId: uuid('sale_id').notNull(),
  position: integer('position').notNull(),
  variantId: uuid('variant_id').notNull(),
  description: text('description').notNull(),
  sku: text('sku'),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: money('unit_price_minor').notNull(),
  discountMinor: money('discount_minor').notNull().default(0),
  taxMinor: money('tax_minor').notNull(),
  totalMinor: money('total_minor').notNull(),
  trackInventory: boolean('track_inventory').notNull(),
});

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'canceled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  saleId: uuid('sale_id').notNull(),
  method: text('method', { enum: ['cash', 'card'] }).notNull(),
  status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
  amountMinor: money('amount_minor').notNull(),
  tenderedMinor: money('tendered_minor'),
  changeMinor: money('change_minor'),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  lastError: text('last_error'),
  createdBy: uuid('created_by').notNull(),
  deviceId: uuid('device_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  saleId: uuid('sale_id').notNull(),
  amountMinor: money('amount_minor').notNull(),
  restock: boolean('restock').notNull(),
  reason: text('reason'),
  registerSessionId: uuid('register_session_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const refundLines = pgTable(
  'refund_lines',
  {
    refundId: uuid('refund_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    quantity: integer('quantity').notNull(),
    amountMinor: money('amount_minor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.refundId, t.saleLineId] })],
);

export const refundPayments = pgTable(
  'refund_payments',
  {
    refundId: uuid('refund_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amountMinor: money('amount_minor').notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] }).notNull(),
    providerRef: text('provider_ref'),
  },
  (t) => [primaryKey({ columns: [t.refundId, t.paymentId] })],
);

export const integrationConnections = pgTable('integration_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  provider: text('provider', { enum: ['shopify'] }).notNull(),
  status: text('status', { enum: ['active', 'error', 'disconnected'] }).notNull().default('active'),
  shopDomain: text('shop_domain').notNull(),
  credentials: text('credentials').notNull(),
  settings: jsonb('settings').$type<{ onlineOrdersLocationId?: string }>().notNull().default({}),
  statusMessage: text('status_message'),
  lastImportAt: timestamp('last_import_at', { withTimezone: true }),
  lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  ordersCheckedAt: timestamp('orders_checked_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const externalMappings = pgTable(
  'external_mappings',
  {
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    kind: text('kind', { enum: ['product', 'variant', 'location'] }).notNull(),
    externalId: text('external_id').notNull(),
    internalId: uuid('internal_id').notNull(),
    data: jsonb('data').$type<{ inventoryItemId?: string }>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.kind, t.externalId] })],
);

export const inventoryPushState = pgTable(
  'inventory_push_state',
  {
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    locationId: uuid('location_id').notNull(),
    lastPushed: integer('last_pushed'),
    pushSeq: integer('push_seq').notNull().default(0),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.variantId, t.locationId] })],
);

export const syncIssues = pgTable('sync_issues', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  externalRef: text('external_ref'),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export const processedWebhooks = pgTable(
  'processed_webhooks',
  {
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.webhookId] })],
);

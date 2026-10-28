import type { PermissionDefinition } from './permissions';

export const MODULE_IDS = [
  'catalog',
  'inventory',
  'pos',
  'time-clock',
  'scheduling',
  'tasks',
  'ecommerce-sync',
  'reporting',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export interface NavItem {
  label: string;
  /** Path relative to the business root in the admin hub, e.g. "/inventory". */
  path: string;
  /** Hide the item from members who lack this permission. */
  permission?: string;
}

export interface ModuleDefinition {
  id: ModuleId;
  name: string;
  description: string;
  version: string;
  /** Modules that must be enabled before this one can be. */
  dependsOn: readonly ModuleId[];
  permissions: readonly PermissionDefinition[];
  nav: readonly NavItem[];
  /** Build phase that ships the module's functionality; the entitlement exists before then. */
  phase: number;
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    id: 'catalog',
    name: 'Product catalog',
    description: 'Products, variants, barcodes and pricing.',
    version: '0.1.0',
    dependsOn: [],
    permissions: [
      { key: 'catalog.read', description: 'View products' },
      { key: 'catalog.manage', description: 'Create and edit products and prices' },
    ],
    nav: [{ label: 'Products', path: '/catalog', permission: 'catalog.read' }],
    phase: 2,
  },
  {
    id: 'inventory',
    name: 'Inventory',
    description: 'Stock movements, transfers and mobile count sessions.',
    version: '0.1.0',
    dependsOn: ['catalog'],
    permissions: [
      { key: 'inventory.read', description: 'View stock levels and movements' },
      { key: 'inventory.adjust', description: 'Receive, transfer and adjust stock' },
      { key: 'inventory.count', description: 'Record counts' },
      { key: 'inventory.count.approve', description: 'Approve count adjustments' },
    ],
    nav: [
      { label: 'Stock levels', path: '/inventory', permission: 'inventory.read' },
      { label: 'Counts', path: '/inventory/counts', permission: 'inventory.count' },
    ],
    phase: 2,
  },
  {
    id: 'pos',
    name: 'Point of sale',
    description: 'Checkout, card payments, refunds and register sessions.',
    version: '0.1.0',
    dependsOn: ['catalog'],
    permissions: [
      { key: 'pos.sell', description: 'Ring up sales' },
      { key: 'pos.refund', description: 'Issue refunds' },
      { key: 'pos.discount', description: 'Apply manual discounts' },
      { key: 'pos.register.manage', description: 'Open, close and reconcile registers' },
    ],
    nav: [
      { label: 'Sales', path: '/sales', permission: 'pos.sell' },
      { label: 'Registers', path: '/registers', permission: 'pos.register.manage' },
    ],
    phase: 4,
  },
  {
    id: 'time-clock',
    name: 'Time clock',
    description: 'Clock-in, clock-out, breaks and timecard approval.',
    version: '0.1.0',
    dependsOn: [],
    permissions: [
      { key: 'timeclock.punch', description: 'Clock in and out' },
      { key: 'timeclock.manage', description: 'Edit and approve timecards' },
    ],
    nav: [
      { label: 'Clock in / out', path: '/clock', permission: 'timeclock.punch' },
      { label: 'Timecards', path: '/timecards', permission: 'timeclock.manage' },
    ],
    phase: 6,
  },
  {
    id: 'scheduling',
    name: 'Scheduling',
    description: 'Shifts, availability and shift assignment.',
    version: '0.1.0',
    dependsOn: [],
    permissions: [
      { key: 'scheduling.read', description: 'View the schedule' },
      { key: 'scheduling.manage', description: 'Build and publish schedules' },
    ],
    nav: [{ label: 'Schedule', path: '/schedule', permission: 'scheduling.read' }],
    phase: 6,
  },
  {
    id: 'tasks',
    name: 'Tasks',
    description: 'Checklists, assignments and completion records.',
    version: '0.1.0',
    dependsOn: [],
    permissions: [
      { key: 'tasks.complete', description: 'Complete assigned tasks' },
      { key: 'tasks.manage', description: 'Create and assign tasks' },
    ],
    nav: [
      { label: 'Today’s tasks', path: '/tasks', permission: 'tasks.complete' },
      { label: 'Checklists', path: '/tasks/manage', permission: 'tasks.manage' },
    ],
    phase: 6,
  },
  {
    id: 'ecommerce-sync',
    name: 'Website sync',
    description: 'Keep products and stock in sync with your online store.',
    version: '0.1.0',
    dependsOn: ['catalog'],
    permissions: [{ key: 'sync.manage', description: 'Connect stores and resolve sync issues' }],
    nav: [{ label: 'Website sync', path: '/sync', permission: 'sync.manage' }],
    phase: 5,
  },
  {
    id: 'reporting',
    name: 'Reporting',
    description: 'Sales, inventory and labor reports across the tools you use.',
    version: '0.1.0',
    dependsOn: [],
    permissions: [{ key: 'reports.read', description: 'View reports' }],
    nav: [{ label: 'Reports', path: '/reports', permission: 'reports.read' }],
    phase: 6,
  },
];

const byId = new Map<ModuleId, ModuleDefinition>(MODULES.map((m) => [m.id, m]));

export function isModuleId(value: string): value is ModuleId {
  return byId.has(value as ModuleId);
}

export function getModule(id: ModuleId): ModuleDefinition {
  const mod = byId.get(id);
  if (!mod) throw new Error(`Unknown module: ${id}`);
  return mod;
}

/** Dependencies of `id` that are not in `enabled`. Empty means the module can be enabled. */
export function missingDependencies(id: ModuleId, enabled: ReadonlySet<ModuleId>): ModuleId[] {
  return getModule(id).dependsOn.filter((dep) => !enabled.has(dep));
}

/** Enabled modules that depend on `id`. Empty means the module can be disabled. */
export function enabledDependents(id: ModuleId, enabled: ReadonlySet<ModuleId>): ModuleId[] {
  return MODULES.filter((m) => enabled.has(m.id) && m.dependsOn.includes(id)).map((m) => m.id);
}

import { ALL_PERMISSIONS, PLATFORM_PERMISSIONS } from './permissions';
import { MODULES } from './registry';

export interface SystemRoleTemplate {
  key: 'owner' | 'manager' | 'staff';
  name: string;
  permissions: string[];
}

/** Roles every new business starts with. The owner role cannot be edited. */
export const SYSTEM_ROLES: readonly SystemRoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: [ALL_PERMISSIONS] },
  {
    key: 'manager',
    name: 'Manager',
    permissions: [
      'locations.manage',
      'members.read',
      'devices.manage',
      'audit.read',
      'catalog.read',
      'catalog.manage',
      'inventory.read',
      'inventory.adjust',
      'inventory.count',
      'inventory.count.approve',
      'pos.sell',
      'pos.refund',
      'pos.discount',
      'pos.register.manage',
      'timeclock.punch',
      'timeclock.manage',
      'scheduling.read',
      'scheduling.manage',
      'tasks.complete',
      'tasks.manage',
      'sync.manage',
      'reports.read',
    ],
  },
  {
    key: 'staff',
    name: 'Staff',
    permissions: [
      'catalog.read',
      'inventory.read',
      'inventory.count',
      'pos.sell',
      'timeclock.punch',
      'scheduling.read',
      'tasks.complete',
    ],
  },
];

/** Every permission key a custom role may be granted. */
export function knownPermissionKeys(): Set<string> {
  return new Set([
    ...PLATFORM_PERMISSIONS.map((p) => p.key),
    ...MODULES.flatMap((m) => m.permissions.map((p) => p.key)),
  ]);
}

export interface PermissionDefinition {
  key: string;
  description: string;
}

/** Wildcard granted to the owner role: every current and future permission. */
export const ALL_PERMISSIONS = '*';

/** Permissions that belong to the platform itself rather than an optional module. */
export const PLATFORM_PERMISSIONS: readonly PermissionDefinition[] = [
  { key: 'tenant.manage', description: 'Edit business details' },
  { key: 'locations.manage', description: 'Create and edit locations' },
  { key: 'members.read', description: 'View team members' },
  { key: 'members.manage', description: 'Change member roles and suspend members' },
  { key: 'roles.manage', description: 'Create and edit roles' },
  { key: 'devices.manage', description: 'Register and revoke registers and handhelds' },
  { key: 'modules.manage', description: 'Turn tools on and off for the business' },
  { key: 'audit.read', description: 'View the audit log' },
];

export function hasPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(ALL_PERMISSIONS) || granted.includes(required);
}

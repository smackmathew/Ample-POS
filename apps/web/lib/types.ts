export interface Me {
  user: { id: string; email: string | null; displayName: string | null };
  tenants: { id: string; name: string; slug: string; role: { key: string; name: string } }[];
}

export interface CurrentTenant {
  tenant: { id: string; name: string; slug: string };
  membership: { id: string; role: { id: string; key: string }; permissions: string[] };
  enabledModules: string[];
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

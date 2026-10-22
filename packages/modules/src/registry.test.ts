import { describe, expect, it } from 'vitest';
import {
  MODULES,
  PLATFORM_PERMISSIONS,
  SYSTEM_ROLES,
  enabledDependents,
  hasPermission,
  knownPermissionKeys,
  missingDependencies,
  type ModuleId,
} from './index';

describe('module registry', () => {
  it('has unique module ids and permission keys', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    const keys = [...PLATFORM_PERMISSIONS, ...MODULES.flatMap((m) => m.permissions)].map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only depends on registered modules, without cycles', () => {
    const ids = new Set(MODULES.map((m) => m.id));
    const visit = (id: ModuleId, path: ModuleId[]): void => {
      expect(path).not.toContain(id);
      const mod = MODULES.find((m) => m.id === id)!;
      for (const dep of mod.dependsOn) {
        expect(ids.has(dep)).toBe(true);
        visit(dep, [...path, id]);
      }
    };
    MODULES.forEach((m) => visit(m.id, []));
  });

  it('nav items reference permissions the module declares', () => {
    for (const mod of MODULES) {
      const own = new Set(mod.permissions.map((p) => p.key));
      for (const item of mod.nav) {
        if (item.permission) expect(own.has(item.permission)).toBe(true);
      }
    }
  });

  it('reports missing dependencies and enabled dependents', () => {
    expect(missingDependencies('inventory', new Set())).toEqual(['catalog']);
    expect(missingDependencies('inventory', new Set(['catalog']))).toEqual([]);
    expect(enabledDependents('catalog', new Set(['catalog', 'inventory', 'pos']))).toEqual(['inventory', 'pos']);
    expect(enabledDependents('catalog', new Set(['catalog', 'time-clock']))).toEqual([]);
  });
});

describe('permissions', () => {
  it('owner wildcard grants everything', () => {
    expect(hasPermission(['*'], 'pos.refund')).toBe(true);
    expect(hasPermission(['pos.sell'], 'pos.refund')).toBe(false);
  });

  it('system roles only use known permissions', () => {
    const known = knownPermissionKeys();
    for (const role of SYSTEM_ROLES.filter((r) => r.key !== 'owner')) {
      for (const p of role.permissions) expect(known.has(p)).toBe(true);
    }
  });
});

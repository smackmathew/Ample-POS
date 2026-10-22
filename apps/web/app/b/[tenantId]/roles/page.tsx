import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { ModuleSummary, Role } from '@/lib/types';
import { saveRole } from '../actions';

const PLATFORM_GROUP = {
  name: 'Business',
  permissions: [
    { key: 'tenant.manage', description: 'Edit business details' },
    { key: 'locations.manage', description: 'Create and edit locations' },
    { key: 'members.read', description: 'View team members' },
    { key: 'members.manage', description: 'Change member roles and suspend members' },
    { key: 'roles.manage', description: 'Create and edit roles' },
    { key: 'devices.manage', description: 'Register and revoke devices' },
    { key: 'modules.manage', description: 'Turn tools on and off' },
    { key: 'audit.read', description: 'View the audit log' },
  ],
};

export default async function RolesPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [roles, modules] = await Promise.all([
    api<Role[]>('/roles', { tenantId }),
    api<ModuleSummary[]>('/modules', { tenantId }),
  ]);
  const groups = [PLATFORM_GROUP, ...modules.map((m) => ({ name: m.name, permissions: m.permissions }))];

  const editor = (role: Role | null) => (
    <ActionForm key={role?.id ?? 'new'} action={saveRole.bind(null, tenantId, role?.id ?? null)} className="card space-y-4">
      <div className="flex items-center gap-3">
        <input name="name" defaultValue={role?.name} placeholder="New role name" required className="input max-w-xs" />
        {role?.isSystem && <span className="text-xs text-stone-500">Built-in</span>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g.name}>
            <legend className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{g.name}</legend>
            {g.permissions.map((p) => (
              <label key={p.key} className="mt-1 flex items-center gap-2 text-sm">
                <input type="checkbox" name="permissions" value={p.key} defaultChecked={role?.permissions.includes(p.key)} />
                {p.description}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <button className="btn">{role ? 'Save role' : 'Create role'}</button>
    </ActionForm>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Roles</h1>
      <p className="text-sm text-stone-600">The Owner role always has every permission and cannot be edited.</p>
      {roles.filter((r) => r.key !== 'owner').map(editor)}
      {editor(null)}
    </div>
  );
}

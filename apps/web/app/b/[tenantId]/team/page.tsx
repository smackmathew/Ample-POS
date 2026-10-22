import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type Member, type Role } from '@/lib/types';
import { inviteMember, updateMember } from '../actions';

export default async function TeamPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, members, roles] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<Member[]>('/members', { tenantId }),
    api<Role[]>('/roles', { tenantId }),
  ]);
  const canManage = can(current.membership.permissions, 'members.manage');

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <ul className="card divide-y divide-stone-100">
        {members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium">{m.user.displayName ?? m.user.email}</p>
              <p className="text-xs text-stone-500">
                {m.user.email} · {m.status}
              </p>
            </div>
            {canManage ? (
              <ActionForm action={updateMember.bind(null, tenantId, m.id)} className="flex items-center gap-2">
                <select name="roleId" defaultValue={m.role.id} className="input w-36">
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <select name="status" defaultValue={m.status} className="input w-32">
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
                <button className="btn-secondary">Save</button>
              </ActionForm>
            ) : (
              <span className="text-sm">{m.role.name}</span>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <ActionForm
          action={inviteMember.bind(null, tenantId)}
          className="card grid gap-3 sm:grid-cols-3"
          secretLabel="Invitation code — send it to the new team member. It expires in 7 days."
        >
          <h2 className="font-medium sm:col-span-3">Invite someone</h2>
          <input name="email" type="email" placeholder="Email (optional, locks the code to it)" className="input sm:col-span-2" />
          <select name="roleId" defaultValue={roles.find((r) => r.key === 'staff')?.id} className="input">
            {roles
              .filter((r) => r.key !== 'owner')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
          <button className="btn sm:justify-self-start">Create invitation</button>
        </ActionForm>
      )}
    </div>
  );
}

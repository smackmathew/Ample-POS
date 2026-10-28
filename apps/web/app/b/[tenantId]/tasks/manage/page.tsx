import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDay } from '@/lib/time';
import type { Location, Member, Role } from '@/lib/types';
import { archiveChecklist, createChecklist } from '../../workforce-actions';

interface Checklist {
  id: string;
  title: string;
  recurrence: 'once' | 'daily' | 'weekly';
  weekdays: number[];
  dueDate: string | null;
  locationId: string | null;
  assigneeUserId: string | null;
  assigneeRoleKey: string | null;
  items: { id: string; label: string }[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function ManageChecklists({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [lists, locations, roles, members] = await Promise.all([
    api<Checklist[]>('/tasks/checklists', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
    api<Role[]>('/roles', { tenantId }),
    api<Member[]>('/members', { tenantId }),
  ]);
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const person = new Map(members.map((m) => [m.user.id, m.user.displayName ?? m.user.email]));
  const when = (c: Checklist) =>
    c.recurrence === 'daily' ? 'Every day' : c.recurrence === 'weekly' ? c.weekdays.map((d) => DAYS[d]).join(', ') : `Once, ${formatDay(c.dueDate!)}`;
  const who = (c: Checklist) => (c.assigneeUserId ? person.get(c.assigneeUserId) : c.assigneeRoleKey ? `Anyone with role ${roleName.get(c.assigneeRoleKey)}` : 'Anyone');

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Checklists</h1>
      <ul className="space-y-3">
        {lists.map((c) => (
          <li key={c.id} className="card">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{c.title}</p>
                <p className="text-sm text-stone-500">
                  {when(c)} · {who(c)}
                  {c.locationId ? ` · ${locations.find((l) => l.id === c.locationId)?.name}` : ' · all locations'}
                </p>
              </div>
              <form action={archiveChecklist.bind(null, tenantId, c.id)}>
                <button className="text-xs text-red-700 hover:underline">Archive</button>
              </form>
            </div>
            <ol className="mt-2 list-decimal pl-5 text-sm text-stone-700">
              {c.items.map((i) => (
                <li key={i.id}>{i.label}</li>
              ))}
            </ol>
          </li>
        ))}
        {lists.length === 0 && <li className="text-stone-500">No checklists yet.</li>}
      </ul>

      <ActionForm action={createChecklist.bind(null, tenantId)} className="card space-y-3">
        <h2 className="font-medium">New checklist</h2>
        <input name="title" placeholder="e.g. Opening" required className="input" />
        <div className="grid gap-2 sm:grid-cols-3">
          <select name="recurrence" className="input">
            <option value="daily">Every day</option>
            <option value="weekly">Certain weekdays</option>
            <option value="once">Once</option>
          </select>
          <input name="dueDate" type="date" className="input" aria-label="Due date (for once)" />
          <select name="locationId" className="input">
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="mb-1 text-xs text-stone-500">Weekdays (for certain weekdays)</legend>
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" name="weekdays" value={i} /> {d}
            </label>
          ))}
        </fieldset>
        <select name="assignee" className="input">
          <option value="">Anyone</option>
          {roles
            .filter((r) => r.key !== 'owner')
            .map((r) => (
              <option key={r.key} value={`role:${r.key}`}>
                Role: {r.name}
              </option>
            ))}
          {members.map((m) => (
            <option key={m.user.id} value={`user:${m.user.id}`}>
              {m.user.displayName ?? m.user.email}
            </option>
          ))}
        </select>
        <textarea name="items" rows={5} placeholder={'One item per line\nCount the float\nTurn on lights'} required className="input" />
        <button className="btn">Create checklist</button>
      </ActionForm>
    </div>
  );
}

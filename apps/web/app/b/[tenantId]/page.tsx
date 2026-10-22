import Link from 'next/link';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type Device, type Location, type Member } from '@/lib/types';

export default async function Dashboard({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const current = await api<CurrentTenant>('/tenant', { tenantId });
  const perms = current.membership.permissions;
  const [locations, devices, members] = await Promise.all([
    api<Location[]>('/locations', { tenantId }),
    can(perms, 'devices.manage') ? api<Device[]>('/devices', { tenantId }) : Promise.resolve(null),
    can(perms, 'members.read') ? api<Member[]>('/members', { tenantId }) : Promise.resolve(null),
  ]);

  const base = `/b/${tenantId}`;
  const steps = [
    { done: current.enabledModules.length > 0, label: 'Choose the tools your business uses', href: `${base}/tools`, show: can(perms, 'modules.manage') },
    { done: locations.length > 0, label: 'Add your first location', href: `${base}/locations`, show: can(perms, 'locations.manage') },
    { done: (devices?.length ?? 0) > 0, label: 'Register a register or handheld', href: `${base}/devices`, show: devices !== null },
    { done: (members?.length ?? 0) > 1, label: 'Invite your team', href: `${base}/team`, show: can(perms, 'members.manage') },
  ].filter((s) => s.show);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Welcome to {current.tenant.name}</h1>
      {steps.length > 0 && (
        <section className="card">
          <h2 className="font-medium">Setup checklist</h2>
          <ul className="mt-3 space-y-2">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 text-sm">
                <span className={s.done ? 'text-brand' : 'text-stone-400'}>{s.done ? '✓' : '○'}</span>
                <Link href={s.href} className={s.done ? 'text-stone-500 line-through' : 'hover:underline'}>
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="grid grid-cols-3 gap-4">
        <Stat label="Tools enabled" value={current.enabledModules.length} />
        <Stat label="Locations" value={locations.length} />
        <Stat label="Team members" value={members?.length ?? '—'} />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

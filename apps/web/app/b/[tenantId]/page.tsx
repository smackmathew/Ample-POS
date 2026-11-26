import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { addDays, formatDay, localDate } from '@/lib/time';
import { can, type CurrentTenant, type Device, type Location, type Member, type NavSection } from '@/lib/types';

interface SalesWeek {
  days: { date: string; salesCount: number; netMinor: number }[];
  totals: { salesCount: number; netMinor: number };
}

export default async function Dashboard({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, nav] = await Promise.all([api<CurrentTenant>('/tenant', { tenantId }), api<{ sections: NavSection[] }>('/navigation', { tenantId })]);
  const perms = current.membership.permissions;
  const on = new Set(current.enabledModules);
  const [locations, devices, members] = await Promise.all([
    api<Location[]>('/locations', { tenantId }),
    can(perms, 'devices.manage') ? api<Device[]>('/devices', { tenantId }) : Promise.resolve(null),
    can(perms, 'members.read') ? api<Member[]>('/members', { tenantId }) : Promise.resolve(null),
  ]);
  const today = localDate(new Date(), locations[0]?.timezone ?? 'UTC');
  const from = addDays(today, -6);
  const week =
    on.has('reporting') && on.has('pos') && can(perms, 'reports.read')
      ? await api<SalesWeek>(`/reports/sales?from=${from}&to=${today}`, {
          tenantId,
        }).catch(() => null)
      : null;

  const base = `/b/${tenantId}`;
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  const paths = new Set(nav.sections.flatMap((s) => s.items.map((i) => i.path)));
  const shortcuts = (
    [
      ['/sales', 'Ring up a sale', 'Open the register on the web'],
      ['/catalog', 'Products', 'Add items, prices and barcodes'],
      ['/customers', 'Customers', 'Profiles and purchase history'],
      ['/inventory', 'Stock levels', 'What you have, store by store'],
      ['/reports', 'Reports', 'Sales, stock and labor'],
      ['/tasks', 'Today’s tasks', 'Opening and closing checklists'],
    ] as const
  )
    .filter(([path]) => paths.has(path))
    .slice(0, 4);

  const steps = [
    {
      done: current.enabledModules.length > 0,
      label: 'Choose the tools your business uses',
      href: `${base}/tools`,
      show: can(perms, 'modules.manage'),
    },
    {
      done: locations.length > 0,
      label: 'Add your first location',
      href: `${base}/locations`,
      show: can(perms, 'locations.manage'),
    },
    {
      done: (devices?.length ?? 0) > 0,
      label: 'Pair a register or handheld',
      href: `${base}/devices`,
      show: devices !== null,
    },
    {
      done: (members?.length ?? 0) > 1,
      label: 'Invite your team',
      href: `${base}/team`,
      show: can(perms, 'members.manage'),
    },
  ].filter((s) => s.show);
  const done = steps.filter((s) => s.done).length;

  const billing = current.billing;
  const trialDays = billing ? Math.max(0, Math.ceil((Date.parse(billing.trialEndsAt) - Date.now()) / 86_400_000)) : 0;
  const status =
    billing?.standing === 'free'
      ? 'Free account'
      : billing?.standing === 'trial'
        ? `Free trial · ${trialDays} day${trialDays === 1 ? '' : 's'} left`
        : billing?.standing === 'active'
          ? 'Subscribed'
          : billing?.standing === 'past_due'
            ? 'Payment problem'
            : billing?.standing === 'lapsed'
              ? 'Trial ended'
              : null;

  const todayNet = week?.days.find((d) => d.date === today)?.netMinor ?? 0;
  const todayCount = week?.days.find((d) => d.date === today)?.salesCount ?? 0;
  const series = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    return {
      date,
      net: week?.days.find((d) => d.date === date)?.netMinor ?? 0,
    };
  });
  const peak = Math.max(1, ...series.map((d) => d.net));

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-teal-100 bg-gradient-to-br from-teal-50 via-white to-white p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-brand">{formatDay(today)}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{current.tenant.name}</h1>
            <p className="mt-2 text-stone-600">
              {locations.length === 0
                ? 'Let’s get your store ready to sell.'
                : `${locations.length} location${locations.length === 1 ? '' : 's'} · ${current.enabledModules.length} tools on`}
            </p>
          </div>
          {status && (
            <Link
              href={can(perms, 'billing.manage') ? `${base}/billing` : base}
              className="rounded-full border border-teal-200 bg-white px-3 py-1 text-sm font-medium text-brand shadow-xs hover:border-brand"
            >
              {status}
            </Link>
          )}
        </div>
        {shortcuts.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {shortcuts.map(([path, label, hint]) => (
              <Link
                key={path}
                href={`${base}${path}`}
                className="group rounded-2xl border border-stone-200/80 bg-white/80 p-4 transition hover:border-brand hover:shadow-sm"
              >
                <span className="flex items-center justify-between font-medium">
                  {label}
                  <span className="text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-brand">→</span>
                </span>
                <span className="mt-0.5 block text-sm text-stone-500">{hint}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {week && (
        <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Today" value={money(todayNet)} note={`${todayCount} sale${todayCount === 1 ? '' : 's'}`} />
            <Stat label="Last 7 days" value={money(week.totals.netMinor)} note={`${week.totals.salesCount} sales`} />
            <Stat
              label="Average sale"
              value={week.totals.salesCount ? money(Math.round(week.totals.netMinor / week.totals.salesCount)) : '—'}
              note="Last 7 days"
            />
            <Stat label="Team" value={members?.length ?? '—'} note={`${locations.length} location${locations.length === 1 ? '' : 's'}`} />
          </div>
          <div className="card">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Sales this week</h2>
              <Link href={`${base}/reports`} className="text-sm text-brand hover:underline">
                Reports →
              </Link>
            </div>
            <div className="mt-6 flex h-40 items-end gap-2 sm:gap-3">
              {series.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-2">
                  <div className="flex h-32 w-full items-end">
                    <div
                      title={`${formatDay(d.date)}: ${money(d.net)}`}
                      className={`w-full rounded-t-md ${d.date === today ? 'bg-brand' : 'bg-brand/25'}`}
                      style={{
                        height: `${Math.max(3, (d.net / peak) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-[11px] text-stone-500">
                    {new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {steps.length > 0 && done < steps.length && (
          <section className="card">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Get set up</h2>
              <span className="text-sm text-stone-500">
                {done} of {steps.length} done
              </span>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-stone-100">
              <div className="h-1.5 rounded-full bg-brand transition-all" style={{ width: `${(done / steps.length) * 100}%` }} />
            </div>
            <ul className="mt-4 space-y-1">
              {steps.map((s) => (
                <li key={s.label}>
                  <Link href={s.href} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-stone-50">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${s.done ? 'bg-brand text-white' : 'border border-stone-300 text-transparent'}`}
                    >
                      ✓
                    </span>
                    <span className={s.done ? 'text-stone-400 line-through' : ''}>{s.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!week && (
          <section className="grid grid-cols-3 gap-4 self-start">
            <Stat label="Tools on" value={current.enabledModules.length} />
            <Stat label="Locations" value={locations.length} />
            <Stat label="Team" value={members?.length ?? '—'} />
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-0.5 text-xs text-stone-400">{note}</p>}
    </div>
  );
}

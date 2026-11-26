import type { Person } from '@/lib/platform';

/** How someone signs in, at a glance. */
export function Flags({ p }: { p: Person }) {
  const flags: [string, string][] = [];
  if (p.disabledAt) flags.push(['Turned off', 'bg-red-50 text-red-700']);
  if (p.locked) flags.push(['Locked out', 'bg-amber-50 text-amber-800']);
  if (p.hasPassword && !p.emailVerified) flags.push(['Email not confirmed', 'bg-amber-50 text-amber-800']);
  if (p.twoFactor) flags.push(['Two-step on', 'bg-brand-soft text-brand']);
  if (p.platformAdmin) flags.push(['Staff', 'bg-violet-50 text-violet-800']);
  if (!flags.length) flags.push(['OK', 'bg-stone-100 text-stone-600']);
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map(([label, tone]) => (
        <span key={label} className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
          {label}
        </span>
      ))}
    </span>
  );
}

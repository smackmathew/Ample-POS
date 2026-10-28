import Link from 'next/link';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type NavSection, type TenantBilling } from '@/lib/types';

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const [current, nav] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<{ sections: NavSection[] }>('/navigation', { tenantId }),
  ]);
  const base = `/b/${tenantId}`;

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-stone-200 bg-white p-4">
        <Link href={base} className="block text-lg font-semibold">
          {current.tenant.name}
        </Link>
        <Link href="/businesses" className="text-xs text-stone-500 hover:underline">
          Switch business
        </Link>
        <nav className="mt-6 space-y-5">
          {nav.sections.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{section.title}</p>
              <ul className="mt-1 space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.path}>
                    <Link href={`${base}${item.path}`} className="block rounded px-2 py-1 text-sm hover:bg-stone-100">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <BillingBanner billing={current.billing} href={can(current.membership.permissions, 'billing.manage') ? `${base}/billing` : null} />
        {children}
      </main>
    </div>
  );
}

/** Trial reminders and payment problems, shown on every page. Only owners get the link to fix them. */
function BillingBanner({ billing, href }: { billing: TenantBilling | null; href: string | null }) {
  if (!billing) return null;
  const days = Math.ceil((Date.parse(billing.trialEndsAt) - Date.now()) / 86_400_000);
  let message: string | null = null;
  let tone = 'border-amber-200 bg-amber-50';
  if (billing.standing === 'lapsed') {
    message = href
      ? 'Your free trial has ended. Paid tools are read-only until you subscribe.'
      : 'The free trial has ended. Paid tools are read-only until the owner subscribes.';
    tone = 'border-red-200 bg-red-50';
  } else if (billing.standing === 'past_due') {
    message = href ? 'Your last payment failed. Update your card to keep everything running.' : 'There is a billing problem; let the owner know.';
    tone = 'border-red-200 bg-red-50';
  } else if (billing.standing === 'trial' && days <= 3 && href) {
    message = `Your free trial ends in ${days} day${days === 1 ? '' : 's'}.`;
  }
  if (!message) return null;
  return (
    <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <span>{message}</span>
      {href && (
        <Link href={href} className="btn px-3 py-1.5 text-sm">
          {billing.standing === 'past_due' ? 'Fix billing' : 'Subscribe'}
        </Link>
      )}
    </div>
  );
}

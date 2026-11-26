import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountLinks, AppShell } from '@/components/app-shell';
import { api, ApiError } from '@/lib/api';
import { endSupportView } from '@/app/platform/actions';
import { can, type CurrentTenant, type Me, type NavSection, type TenantBilling } from '@/lib/types';

export default async function TenantLayout({ children, params }: { children: ReactNode; params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let current: CurrentTenant;
  let nav: { sections: NavSection[] };
  let me: Me;
  try {
    [current, nav, me] = await Promise.all([
      api<CurrentTenant>('/tenant', { tenantId }),
      api<{ sections: NavSection[] }>('/navigation', { tenantId }),
      api<Me>('/me'),
    ]);
  } catch (err) {
    // Suspended by Ample POS: say so instead of an error page.
    if (err instanceof ApiError && (err.body as { code?: string } | null)?.code === 'business_suspended') {
      return (
        <main className="mx-auto mt-24 max-w-lg space-y-4 px-4 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">This business is suspended</h1>
          <p className="text-stone-600">{err.message}</p>
          <Link href="/businesses" className="btn-secondary">
            Your businesses
          </Link>
        </main>
      );
    }
    throw err;
  }
  const base = `/b/${tenantId}`;

  const sections = [
    { items: [{ href: base, label: 'Home', exact: true }] },
    ...nav.sections.map((section) => ({
      title: section.title,
      items: section.items.map((item) => ({
        href: `${base}${item.path}`,
        label: item.label,
      })),
    })),
  ];

  return (
    <AppShell
      title={current.tenant.name}
      subtitle={current.support ? 'Support view' : current.membership.role.key === 'owner' ? 'Owner' : 'Team member'}
      badge={current.billing?.standing === 'trial' ? 'Free trial' : undefined}
      sections={sections}
      footer={
        <AccountLinks
          email={me.user.email}
          extra={
            <Link href="/businesses" className="hover:text-stone-900">
              Switch business
            </Link>
          }
        />
      }
    >
      {current.support && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50 px-5 py-3 text-sm">
          <p>
            <strong className="text-violet-900">Ample POS support view: read-only.</strong>{' '}
            <span className="text-stone-700">
              You see what the owner sees, but nothing can be changed. Ends{' '}
              {new Date(current.support.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })}.
              Reason: {current.support.reason}
            </span>
          </p>
          <form action={endSupportView.bind(null, tenantId)}>
            <button className="btn-secondary">End support view</button>
          </form>
        </div>
      )}
      {!current.support && <BillingBanner billing={current.billing} href={can(current.membership.permissions, 'billing.manage') ? `${base}/billing` : null} />}
      {children}
    </AppShell>
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
    <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tone}`}>
      <span>{message}</span>
      {href && (
        <Link href={href} className="btn px-3 py-1.5 text-sm">
          {billing.standing === 'past_due' ? 'Fix billing' : 'Subscribe'}
        </Link>
      )}
    </div>
  );
}

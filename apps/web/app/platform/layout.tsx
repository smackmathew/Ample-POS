import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountLinks, AppShell } from '@/components/app-shell';
import { api } from '@/lib/api';
import type { PlatformAccess } from '@/lib/platform';

const NAV = [
  ['/platform', 'Overview'],
  ['/platform/companies', 'Companies'],
  ['/platform/issues', 'Issues'],
  ['/platform/activity', 'Activity'],
  ['/platform/tools', 'Plans & prices'],
  ['/platform/audit', 'Admin log'],
] as const;

/** The super admin dashboard, for Ample POS staff only. */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const access = await api<PlatformAccess>('/platform/access');
  if (!access.admin) {
    return (
      <main className="mx-auto mt-24 max-w-lg space-y-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Super admin</h1>
        <p className="text-stone-600">{access.message}</p>
        {access.code === 'two_step_required' || access.code === 'email_unverified' ? (
          <Link href="/account" className="btn">
            Your account
          </Link>
        ) : (
          <Link href="/businesses" className="btn-secondary">
            Your businesses
          </Link>
        )}
      </main>
    );
  }
  return (
    <AppShell
      title="Ample POS"
      subtitle="Every company, plans and prices"
      badge="Super admin"
      sections={[
        {
          items: NAV.map(([href, label]) => ({
            href,
            label,
            exact: href === '/platform',
          })),
        },
      ]}
      footer={
        <AccountLinks
          email={access.email ?? ''}
          extra={
            <Link href="/businesses" className="hover:text-stone-900">
              Your businesses
            </Link>
          }
        />
      }
    >
      {children}
    </AppShell>
  );
}

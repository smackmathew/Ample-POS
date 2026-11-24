import Link from 'next/link';
import type { ReactNode } from 'react';
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
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-stone-800 bg-stone-900 p-4 text-stone-100">
        <Link href="/platform" className="block text-lg font-semibold">
          Ample POS
        </Link>
        <p className="text-xs text-stone-400">Super admin · {access.email}</p>
        <nav className="mt-6 space-y-0.5">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="block rounded px-2 py-1.5 text-sm hover:bg-stone-800">
              {label}
            </Link>
          ))}
        </nav>
        <Link href="/businesses" className="mt-8 block text-xs text-stone-400 hover:underline">
          ← Your businesses
        </Link>
      </aside>
      <main className="min-w-0 flex-1 p-8">{children}</main>
    </div>
  );
}

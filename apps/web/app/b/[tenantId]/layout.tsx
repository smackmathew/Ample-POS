import Link from 'next/link';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import type { CurrentTenant, NavSection } from '@/lib/types';

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
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}

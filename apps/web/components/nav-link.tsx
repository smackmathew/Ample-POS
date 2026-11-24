'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A sidebar link that shows when you're on its page (or one below it, unless `exact`). */
export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-lg px-3 py-1.5 text-sm transition ${active ? 'bg-brand-soft font-medium text-brand' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'}`}
    >
      {children}
    </Link>
  );
}

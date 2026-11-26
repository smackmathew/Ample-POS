import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/session-actions';
import { NavLink } from './nav-link';

export interface ShellSection {
  title?: string;
  items: { href: string; label: string; exact?: boolean }[];
}

/** The Ample POS logo (public/logo.png, 4.9:1). */
export function Logo({ href = '/', height = 32 }: { href?: string; height?: number }) {
  return (
    <Link href={href} className="inline-flex shrink-0 items-center" aria-label="Ample POS home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Ample POS" width={Math.round(height * 4.9)} height={height} style={{ height, width: 'auto' }} />
    </Link>
  );
}

/**
 * The signed-in app frame: a sidebar on wide screens, a menu on phones, and
 * the account links up top. Shared by business dashboards and the super admin.
 */
export function AppShell({
  title,
  subtitle,
  badge,
  sections,
  footer,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: string;
  sections: ShellSection[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  const nav = (
    <nav className="space-y-3">
      {sections.map((section, i) => (
        // Each titled group (Business, Product catalog, ...) sits in its own thin-bordered box.
        <div key={section.title ?? i} className={section.title ? 'overflow-hidden rounded-xl border border-brand' : ''}>
          {section.title && <p className="bg-brand-soft px-4 py-1.5 text-[11px] font-semibold tracking-wider text-brand uppercase">{section.title}</p>}
          <ul className={`space-y-0.5 ${section.title ? 'p-1.5' : ''}`}>
            {section.items.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href} exact={item.exact}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
  const heading = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <div className="truncate font-semibold">{title}</div>
        {badge && <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">{badge}</span>}
      </div>
      {subtitle && <div className="truncate text-xs text-stone-500">{subtitle}</div>}
    </div>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-stone-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div className="border-b border-stone-100 px-5 py-4">
          <Logo href="/businesses" />
        </div>
        <div className="px-5 pt-5 pb-4">{heading}</div>
        <div className="flex-1 overflow-y-auto px-2 pb-6">{nav}</div>
        {footer && <div className="border-t border-stone-100 px-5 py-4 text-sm">{footer}</div>}
      </aside>

      {/* Phones and tablets: a top bar with the menu tucked away. */}
      <details className="group border-b border-stone-200 bg-white lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          {heading}
          <span className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm">
            <span className="group-open:hidden">Menu</span>
            <span className="hidden group-open:inline">Close</span>
          </span>
        </summary>
        <div className="space-y-6 px-2 pb-5">
          {nav}
          {footer && <div className="border-t border-stone-100 px-3 pt-4 text-sm">{footer}</div>}
        </div>
      </details>

      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Account links at the bottom of the sidebar. */
export function AccountLinks({ email: raw, extra }: { email: string | null; extra?: ReactNode }) {
  const email = raw || 'Your account';
  return (
    <div className="space-y-2">
      <Link href="/account" className="flex items-center gap-2 text-stone-700 hover:text-stone-900">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand uppercase">
          {email.slice(0, 1)}
        </span>
        <span className="truncate">{email}</span>
      </Link>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500">
        {extra}
        <form action={signOut}>
          <button className="hover:text-stone-900">Sign out</button>
        </form>
      </div>
    </div>
  );
}

/** For pages outside a business: the website's header with the account on the right. */
export function PlainHeader({ email: raw, admin }: { email: string | null; admin?: boolean }) {
  const email = raw || 'Your account';
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-4">
        <Logo />
        <nav className="flex gap-4 text-sm text-stone-600">
          <Link href="/businesses" className="hover:text-stone-900">
            Businesses
          </Link>
          {admin && (
            <Link href="/platform" className="hover:text-stone-900">
              Super admin
            </Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Link href="/account" className="flex items-center gap-2 text-stone-600 hover:text-stone-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand uppercase">
              {email.slice(0, 1)}
            </span>
            <span className="hidden sm:inline">{email}</span>
          </Link>
          <form action={signOut}>
            <button className="btn-secondary px-3 py-1.5">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/app-shell';
import { signedIn } from '@/lib/site';

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const inside = await signedIn();
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4">
          <Logo height={32} />
          <div className="flex gap-5 text-sm text-stone-600">
            <Link href="/features" className="hover:text-stone-900">
              Features
            </Link>
            <Link href="/pricing" className="hover:text-stone-900">
              Pricing
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {inside ? (
              <Link href="/businesses" className="btn">
                Your dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-stone-600 hover:text-stone-900">
                  Sign in
                </Link>
                <Link href="/start" className="btn">
                  Start free trial
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-stone-200 bg-stone-50">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-8 text-sm text-stone-500">
          <span>© {new Date().getFullYear()} Ample POS</span>
          <Link href="/features" className="hover:text-stone-800">
            Features
          </Link>
          <Link href="/pricing" className="hover:text-stone-800">
            Pricing
          </Link>
          <Link href="/start" className="hover:text-stone-800">
            Start free trial
          </Link>
          <Link href="/developers" className="hover:text-stone-800">
            API guide
          </Link>
          <Link href="/login" className="hover:text-stone-800">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}

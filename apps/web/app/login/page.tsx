import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { authConfig } from '@/lib/api';
import { devSignIn, signIn } from '../session-actions';
import { Logo } from '@/components/app-shell';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const config = await authConfig();

  if (config.mode === 'dev') {
    return (
      <main className="mx-auto mt-16 max-w-sm px-4">
        <div className="mb-8">
          <Logo height={36} />
        </div>
        <h1 className="text-2xl font-semibold">Sign in to Ample POS</h1>
        <p className="mt-2 text-sm text-stone-600">
          Demo sign-in: enter any email to continue. Anyone can sign in as any email here, so use test data only, never real customer or payment details.
        </p>
        <ActionForm action={devSignIn} className="card mt-6 grid gap-3">
          <label className="block text-sm">
            Email
            <input name="email" type="email" required className="input mt-1" />
          </label>
          <label className="block text-sm">
            Name
            <input name="name" className="input mt-1" />
          </label>
          <button className="btn w-full">Continue</button>
        </ActionForm>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-16 max-w-sm px-4">
      <div className="mb-8">
        <Logo height={36} />
      </div>
      <h1 className="text-2xl font-semibold">Sign in to Ample POS</h1>
      <ActionForm action={signIn} className="card mt-6 grid gap-3">
        <input type="hidden" name="next" value={next ?? ''} />
        <label className="block text-sm">
          Email
          <input name="email" type="email" autoComplete="email" required className="input mt-1" />
        </label>
        <label className="block text-sm">
          Password
          <input name="password" type="password" autoComplete="current-password" required className="input mt-1" />
        </label>
        <button className="btn w-full">Sign in</button>
      </ActionForm>
      <div className="mt-4 space-y-2 text-sm">
        <p>
          Opening a store?{' '}
          <Link href="/start" className="text-brand hover:underline">
            Start a free trial
          </Link>
        </p>
        <p>
          Joining a team?{' '}
          <Link href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-brand hover:underline">
            Create an account
          </Link>
        </p>
        {config.passwordResetByEmail ? (
          <Link href="/forgot" className="block text-stone-600 hover:underline">
            Forgot password?
          </Link>
        ) : (
          <p className="text-stone-500">Forgot your password? Ask your business owner for a reset link.</p>
        )}
      </div>
    </main>
  );
}

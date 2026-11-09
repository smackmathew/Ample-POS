import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { resetPassword } from '../session-actions';

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      {token ? (
        <>
          <p className="mt-2 text-sm text-stone-600">You’ll be signed in, and signed out on every other device.</p>
          <ActionForm action={resetPassword.bind(null, token)} className="card mt-6 grid gap-3">
            <label className="block text-sm">
              New password
              <input name="password" type="password" autoComplete="new-password" minLength={10} required className="input mt-1" />
              <span className="mt-1 block text-xs text-stone-500">At least 10 characters.</span>
            </label>
            <label className="block text-sm">
              Repeat new password
              <input name="confirm" type="password" autoComplete="new-password" required className="input mt-1" />
            </label>
            <button className="btn w-full">Save password</button>
          </ActionForm>
        </>
      ) : (
        <p className="mt-2 text-sm text-red-700">This link is incomplete. Open the full link from your email or from your business owner.</p>
      )}
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}

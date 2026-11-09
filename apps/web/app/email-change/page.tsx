import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

/** Opened from the link sent to the new address. The link is the proof, so no sign-in is needed. */
export default async function EmailChangePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let email: string | null = null;
  let problem: string | null = null;
  if (!token) problem = 'This link is incomplete. Open the full link from the email.';
  else {
    try {
      ({ email } = await api<{ email: string }>('/auth/email/change/confirm', { method: 'POST', anonymous: true, body: { token } }));
    } catch (err) {
      problem = err instanceof ApiError ? err.message : 'Something went wrong. Try the link again.';
    }
  }
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">{email ? 'Email changed' : 'Couldn’t change your email'}</h1>
      <p className="mt-2 text-sm text-stone-600">
        {email ? (
          <>
            Your account now uses <strong>{email}</strong>. Sign in with it from now on.
          </>
        ) : (
          problem
        )}
      </p>
      <Link href="/account" className="btn mt-6 inline-block">
        Continue
      </Link>
    </main>
  );
}

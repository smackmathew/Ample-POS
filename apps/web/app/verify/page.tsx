import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

/** Opened from the confirmation email. The link itself is the proof, so no sign-in is needed. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let email: string | null = null;
  let problem: string | null = null;
  if (!token) problem = 'This link is incomplete. Open the full link from the email.';
  else {
    try {
      ({ email } = await api<{ email: string }>('/auth/email/verify', { method: 'POST', anonymous: true, body: { token } }));
    } catch (err) {
      problem = err instanceof ApiError ? err.message : 'Something went wrong. Try the link again.';
    }
  }
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">{email ? 'Email confirmed' : 'Couldn’t confirm your email'}</h1>
      <p className="mt-2 text-sm text-stone-600">
        {email ? (
          <>
            <strong>{email}</strong> is confirmed. You can create a business and accept invitations sent to this address.
          </>
        ) : (
          problem
        )}
      </p>
      <Link href="/businesses" className="btn mt-6 inline-block">
        Continue
      </Link>
    </main>
  );
}

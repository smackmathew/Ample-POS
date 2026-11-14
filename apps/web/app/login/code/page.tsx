import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { signInCode } from '../../session-actions';

export default async function SignInCodePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // The password step leaves a challenge here; without it there's nothing to finish.
  if (!(await cookies()).get('pos_2fa')) redirect('/login');
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Enter your code</h1>
      <p className="mt-2 text-sm text-stone-600">Open your authenticator app and enter the 6-digit code for Ample POS. Lost your phone? Use one of your recovery codes instead.</p>
      <ActionForm action={signInCode} className="card mt-6 grid gap-3">
        <input type="hidden" name="next" value={next ?? ''} />
        <label className="block text-sm">
          Code
          <input name="code" autoComplete="one-time-code" inputMode="text" autoFocus required className="input mt-1 tracking-widest" placeholder="123 456" />
        </label>
        <button className="btn w-full">Sign in</button>
      </ActionForm>
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-brand hover:underline">
          Start over
        </Link>
      </p>
    </main>
  );
}

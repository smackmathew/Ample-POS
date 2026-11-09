import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { signUp } from '../session-actions';

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="mt-2 text-sm text-stone-600">
        For business owners and team members alike. Joining a team? Create your account, then enter the invitation code you were given.
      </p>
      <ActionForm action={signUp} className="card mt-6 grid gap-3">
        <input type="hidden" name="next" value={next ?? ''} />
        <label className="block text-sm">
          Your name
          <input name="name" autoComplete="name" required className="input mt-1" />
        </label>
        <label className="block text-sm">
          Email
          <input name="email" type="email" autoComplete="email" required className="input mt-1" />
        </label>
        <label className="block text-sm">
          Password
          <input name="password" type="password" autoComplete="new-password" minLength={10} required className="input mt-1" />
          <span className="mt-1 block text-xs text-stone-500">At least 10 characters. A short phrase is easy to remember and hard to guess.</span>
        </label>
        <label className="block text-sm">
          Repeat password
          <input name="confirm" type="password" autoComplete="new-password" required className="input mt-1" />
        </label>
        <button className="btn w-full">Create account</button>
      </ActionForm>
      <p className="mt-4 text-sm">
        Already have an account?{' '}
        <Link href="/login" className="text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}

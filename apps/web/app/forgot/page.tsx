import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { forgotPassword } from '../session-actions';

export default function ForgotPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <p className="mt-2 text-sm text-stone-600">Enter your account’s email and we’ll send you a link to choose a new password.</p>
      <ActionForm action={forgotPassword} className="card mt-6 grid gap-3">
        <label className="block text-sm">
          Email
          <input name="email" type="email" autoComplete="email" required className="input mt-1" />
        </label>
        <button className="btn w-full">Send reset link</button>
      </ActionForm>
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}

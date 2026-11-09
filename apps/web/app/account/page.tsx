import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { VerifyEmailBanner } from '@/components/verify-email-banner';
import { api, authConfig } from '@/lib/api';
import type { Me } from '@/lib/types';
import { changePassword, signOut, signOutEverywhere } from '../session-actions';

export default async function AccountPage() {
  const [me, config] = await Promise.all([api<Me>('/me'), authConfig()]);
  return (
    <main className="mx-auto mt-16 max-w-xl space-y-6 px-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your account</h1>
        <Link href="/businesses" className="text-sm text-stone-600 hover:underline">
          Your businesses
        </Link>
      </header>
      <VerifyEmailBanner me={me} config={config} />
      <section className="card">
        <p className="font-medium">{me.user.displayName ?? me.user.email}</p>
        <p className="text-sm text-stone-600">
          {me.user.email}
          {config.emailVerification && me.account.emailVerified && me.account.hasPassword && <span className="ml-2 text-teal-700">Confirmed</span>}
        </p>
      </section>

      {config.mode === 'password' && (
        <ActionForm action={changePassword} className="card grid gap-3">
          <h2 className="font-medium">Change password</h2>
          <input name="currentPassword" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
          <input name="newPassword" type="password" autoComplete="new-password" minLength={10} placeholder="New password (at least 10 characters)" required className="input" />
          <input name="confirm" type="password" autoComplete="new-password" placeholder="Repeat new password" required className="input" />
          <button className="btn">Change password</button>
        </ActionForm>
      )}

      <section className="card flex flex-wrap gap-2">
        <form action={signOut}>
          <button className="btn-secondary">Sign out</button>
        </form>
        {config.mode === 'password' && (
          <form action={signOutEverywhere}>
            <button className="btn-secondary">Sign out on every device</button>
          </form>
        )}
      </section>
    </main>
  );
}

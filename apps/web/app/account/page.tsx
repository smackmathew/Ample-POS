import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { VerifyEmailBanner } from '@/components/verify-email-banner';
import { api, authConfig } from '@/lib/api';
import type { Me } from '@/lib/types';
import {
  changeEmail,
  changePassword,
  disableTwoFactor,
  enableTwoFactor,
  newRecoveryCodes,
  setupTwoFactor,
  signOut,
  signOutEverywhere,
} from '../session-actions';

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

      {config.mode === 'password' && me.account.hasPassword && (
        <ActionForm action={changeEmail} className="card grid gap-3">
          <h2 className="font-medium">Change email</h2>
          {config.passwordResetByEmail && <p className="text-sm text-stone-600">We’ll send a link to the new address; the change happens when you open it.</p>}
          <input name="newEmail" type="email" autoComplete="email" placeholder="New email" required className="input" />
          <input name="password" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
          <button className="btn justify-self-start">Change email</button>
        </ActionForm>
      )}

      {config.mode === 'password' && (
        <ActionForm action={changePassword} className="card grid gap-3">
          <h2 className="font-medium">Change password</h2>
          <input name="currentPassword" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
          <input name="newPassword" type="password" autoComplete="new-password" minLength={10} placeholder="New password (at least 10 characters)" required className="input" />
          <input name="confirm" type="password" autoComplete="new-password" placeholder="Repeat new password" required className="input" />
          <button className="btn justify-self-start">Change password</button>
        </ActionForm>
      )}

      {config.mode === 'password' && me.account.hasPassword && <TwoStep tf={me.account.twoFactor} />}

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

const RECOVERY_NOTE = 'Save these recovery codes somewhere safe, like a password manager. Each works once if you lose your phone. They won’t be shown again.';

/** Two-step sign-in: set up with an authenticator app, then manage recovery codes or turn it off. */
function TwoStep({ tf }: { tf: Me['account']['twoFactor'] }) {
  if (!tf.enabled) {
    return (
      <section className="card grid gap-4">
        <div>
          <h2 className="font-medium">Two-step sign-in</h2>
          <p className="mt-1 text-sm text-stone-600">
            Off. Turn it on to ask for a code from an authenticator app (Google Authenticator, 1Password, Authy and others) after your password. Recommended for owners.
          </p>
        </div>
        <ActionForm
          key="2fa-setup"
          action={setupTwoFactor}
          className="grid gap-3"
          secretLabel="Can’t scan? Enter this key in the app instead:"
          qrCaption="Scan with your authenticator app. It will show a new 6-digit code every 30 seconds."
        >
          <input name="password" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
          <button className="btn-secondary justify-self-start">{tf.setupPending ? 'Show a new QR code' : 'Set up two-step sign-in'}</button>
        </ActionForm>
        {tf.setupPending && (
          <ActionForm key="2fa-enable" action={enableTwoFactor} className="grid gap-3 border-t border-stone-100 pt-4" secretLabel={RECOVERY_NOTE}>
            <p className="text-sm">Then enter the 6-digit code your app shows:</p>
            <input name="code" autoComplete="one-time-code" inputMode="numeric" placeholder="123456" required className="input tracking-widest" />
            <div className="flex items-center gap-3">
              <button className="btn">Turn on</button>
              {/* A full reload, so the page switches to its "on" layout. */}
              <a href="/account" className="text-sm text-stone-600 hover:underline">
                Done (after saving your recovery codes)
              </a>
            </div>
          </ActionForm>
        )}
      </section>
    );
  }
  return (
    <section className="card grid gap-4">
      <div>
        <h2 className="font-medium">
          Two-step sign-in <span className="ml-2 text-sm text-teal-700">On</span>
        </h2>
        <p className="mt-1 text-sm text-stone-600">
          {tf.recoveryCodesLeft} recovery code{tf.recoveryCodesLeft === 1 ? '' : 's'} left.
          {tf.recoveryCodesLeft <= 3 && ' Make new ones before you run out.'}
        </p>
      </div>
      <ActionForm key="2fa-codes" action={newRecoveryCodes} className="grid gap-3" secretLabel={RECOVERY_NOTE}>
        <p className="text-sm font-medium">New recovery codes</p>
        <input name="password" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
        <input name="code" autoComplete="one-time-code" placeholder="Code from your app" required className="input" />
        <button className="btn-secondary justify-self-start">Make new codes</button>
      </ActionForm>
      <ActionForm key="2fa-disable" action={disableTwoFactor} className="grid gap-3 border-t border-stone-100 pt-4">
        <p className="text-sm font-medium">Turn off</p>
        <input name="password" type="password" autoComplete="current-password" placeholder="Current password" required className="input" />
        <input name="code" autoComplete="one-time-code" placeholder="Code from your app, or a recovery code" required className="input" />
        <button className="btn-secondary justify-self-start text-red-700">Turn off two-step sign-in</button>
      </ActionForm>
    </section>
  );
}

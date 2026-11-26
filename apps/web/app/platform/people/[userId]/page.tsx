import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { utc, type PersonDetail } from '@/lib/platform';
import { disablePerson, personAction, personResetLink } from '../../actions';
import { Flags } from '../flags';

const ACTION: Record<string, string> = {
  'user.password_reset_link': 'Made a password reset link',
  'user.two_factor_reset': 'Turned off two-step sign-in',
  'user.email_confirmed': 'Confirmed their email',
  'user.disabled': 'Turned the account off',
  'user.enabled': 'Turned the account back on',
};

export default async function PersonPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const p = await api<PersonDetail>(`/platform/users/${userId}`);

  return (
    <div className="max-w-5xl space-y-6">
      <Link href="/platform/people" className="text-sm text-stone-500 hover:underline">
        ← People
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{p.name ?? p.email}</h1>
          <p className="text-sm text-stone-500">
            {p.email} · joined {utc(p.createdAt, false)} · last seen {utc(p.lastSeenAt)}
          </p>
        </div>
        <Flags p={p} />
      </div>

      {p.disabledAt && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm">
          <strong className="text-red-800">Turned off {utc(p.disabledAt)}.</strong> {p.disabledReason}
        </div>
      )}

      <section className="card space-y-2">
        <h2 className="font-medium">Businesses</h2>
        {p.memberships.map((m) => (
          <div key={m.tenantId} className="flex flex-wrap justify-between gap-2 text-sm">
            <span>
              <Link href={`/platform/companies/${m.tenantId}`} className="font-medium hover:underline">
                {m.name}
              </Link>
              <span className="text-stone-500">
                {' '}
                · {m.role}
                {m.status !== 'active' && ` · ${m.status}`}
                {m.suspended && ' · business suspended'}
              </span>
            </span>
            <span className="text-xs text-stone-500">joined {utc(m.joinedAt, false)}</span>
          </div>
        ))}
        {p.memberships.length === 0 && <p className="text-sm text-stone-500">Not in any business.</p>}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="font-medium">Help them sign in</h2>
          <p className="text-sm text-stone-600">
            {p.hasPassword
              ? `${p.liveSessions} signed-in ${p.liveSessions === 1 ? 'device' : 'devices'}. Email ${p.emailVerified ? 'confirmed' : 'not confirmed'}. Two-step sign-in ${p.twoFactor ? 'on' : 'off'}.`
              : 'This person signs in another way (no Ample POS password), so password tools don’t apply.'}
          </p>
          {p.hasPassword && (
            <ActionForm action={personResetLink.bind(null, p.id)} secretLabel="Reset link (works once, for 24 hours)">
              <button className="btn-secondary">Make a password reset link</button>
            </ActionForm>
          )}
          {p.hasPassword && !p.emailVerified && (
            <ActionForm action={personAction.bind(null, p.id, 'confirm-email')}>
              <button className="btn-secondary">Confirm their email</button>
            </ActionForm>
          )}
          {p.twoFactor && (
            <ActionForm action={personAction.bind(null, p.id, 'two-factor/reset')}>
              <button className="btn-secondary">Turn off two-step sign-in</button>
              <p className="mt-1 text-xs text-stone-500">
                For a lost phone and lost recovery codes. Check it’s really them first. They’re signed out everywhere.
              </p>
            </ActionForm>
          )}
        </div>

        <div className="card space-y-3">
          <h2 className="font-medium">Account</h2>
          {p.disabledAt ? (
            <ActionForm action={personAction.bind(null, p.id, 'enable')}>
              <button className="btn">Turn the account back on</button>
            </ActionForm>
          ) : p.platformAdmin ? (
            <p className="text-sm text-stone-600">This is an Ample POS staff account. Remove it from PLATFORM_ADMIN_EMAILS before turning it off.</p>
          ) : (
            <ActionForm action={disablePerson.bind(null, p.id)} className="space-y-2">
              <p className="text-sm text-stone-600">
                They can’t sign in and are signed out everywhere. Their businesses keep working for everyone else; change the owner first if they own one.
              </p>
              <input name="reason" placeholder="Reason (for the record)" required minLength={3} className="input" />
              <button className="btn-secondary text-red-700">Turn account off</button>
            </ActionForm>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">What support did</h2>
        <div className="card space-y-1 text-sm">
          {p.history.map((h, i) => (
            <div key={i} className="flex justify-between gap-3">
              <span>
                {ACTION[h.action] ?? h.action}
                {typeof h.data.reason === 'string' && <span className="text-stone-500"> · {h.data.reason}</span>}
                <span className="text-stone-500"> · {h.by ?? 'staff'}</span>
              </span>
              <span className="text-xs text-stone-500">{utc(h.createdAt)}</span>
            </div>
          ))}
          {p.history.length === 0 && <p className="text-stone-500">Nothing yet.</p>}
        </div>
      </section>
    </div>
  );
}

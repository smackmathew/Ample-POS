import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { confirmEmailByHand, sendTestEmail } from '../actions';

interface EmailStatus {
  mode: 'resend' | 'log' | 'off';
  from: string;
  fromIsPlaceholder: boolean;
}

const MODE: Record<EmailStatus['mode'], [string, string]> = {
  resend: ['Sending with Resend', 'bg-brand-soft text-brand'],
  log: ['Printing to the server log (development only)', 'bg-amber-50 text-amber-800'],
  off: ['Off', 'bg-stone-100 text-stone-600'],
};

/** Email health: setup, a test send with the real error, and confirming someone by hand. */
export default async function EmailPage() {
  const status = await api<EmailStatus>('/platform/email');
  const [label, tone] = MODE[status.mode];
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Email</h1>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${tone}`}>{label}</span>
          <span className="text-sm text-stone-600">
            From <code className="rounded bg-stone-100 px-1.5 py-0.5">{status.from}</code>
          </span>
        </div>
        {status.mode === 'resend' && status.fromIsPlaceholder && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-medium">Emails are being rejected: EMAIL_FROM isn’t set.</p>
            <p className="mt-1">
              Resend only sends from a domain you’ve verified. In Resend, add and verify your domain (Domains → Add domain, then the DNS records it shows). Then in Render,
              set <code>EMAIL_FROM</code> to an address on it, e.g. <code>Ample POS &lt;no-reply@yourdomain.com&gt;</code>, and redeploy.
            </p>
          </div>
        )}
        {status.mode === 'off' && (
          <p className="text-sm text-stone-600">
            Without email, new accounts don’t need to confirm their address, and owners make password reset links on their Team page. Set <code>RESEND_API_KEY</code> and{' '}
            <code>EMAIL_FROM</code> in Render to turn it on.
          </p>
        )}
        <p className="text-xs text-stone-500">
          Until your domain is verified, Resend only delivers to the email address of your own Resend account.
        </p>
      </section>

      <ActionForm action={sendTestEmail} className="card grid gap-3">
        <h2 className="font-semibold">Send a test email</h2>
        <p className="text-sm text-stone-600">Shows the email service’s own error if it refuses.</p>
        <div className="flex flex-wrap gap-2">
          <input name="email" type="email" required placeholder="you@yourdomain.com" className="input max-w-sm" />
          <button className="btn">Send test</button>
        </div>
      </ActionForm>

      <ActionForm action={confirmEmailByHand} className="card grid gap-3">
        <h2 className="font-semibold">Confirm someone’s email by hand</h2>
        <p className="text-sm text-stone-600">
          For a person stuck on “Check your email” while emails can’t get through. Only do this when you know the address is really theirs. It’s recorded in the admin log.
        </p>
        <div className="flex flex-wrap gap-2">
          <input name="email" type="email" required placeholder="their sign-in email" className="input max-w-sm" />
          <button className="btn-secondary">Mark as confirmed</button>
        </div>
      </ActionForm>
    </div>
  );
}

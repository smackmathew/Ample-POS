import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { connectOwn, openDashboard, refreshMerchant, startPlatform, turnOffCards } from '../payments-actions';

interface MerchantView {
  mode: 'off' | 'platform' | 'own';
  ready: boolean;
  message: string | null;
  simulated: boolean;
  ownKeysSupported: boolean;
  platform: { accountId: string; chargesEnabled: boolean | null; payoutsEnabled: boolean | null; requirementsDue: string[]; disabledReason: string | null } | null;
  own: { accountId: string; businessName: string | null; livemode: boolean | null; webhookConfigured: boolean } | null;
  ownWebhookUrl: string;
  statusSyncedAt: string | null;
}

/** Stripe's requirement codes, in words. */
const DUE: Record<string, string> = {
  external_account: 'a bank account for payouts',
  'business_profile.url': 'your website',
  'business_profile.mcc': 'what your business sells',
  tos_acceptance: 'accepting Stripe’s terms',
  'individual.verification.document': 'a photo ID',
  'individual.id_number': 'your tax ID',
};
const due = (code: string) => DUE[code] ?? code.replace(/[._]/g, ' ');

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ onboarding?: string }> }) {
  const { tenantId } = await params;
  const { onboarding } = await searchParams;
  // Back from Stripe's form: read the latest status first.
  if (onboarding) await api('/payments/merchant/refresh', { tenantId, method: 'POST' }).catch(() => null);
  const m = await api<MerchantView>('/payments/merchant', { tenantId });
  const platformOn = m.mode === 'platform';
  const ownOn = m.mode === 'own';

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Card payments</h1>
        <p className="mt-1 text-stone-600">Choose how your registers take cards. Cash and gift cards work either way.</p>
      </div>

      <section className={`card ${m.ready ? 'border-teal-200 bg-teal-50' : 'border-amber-200 bg-amber-50'}`}>
        <p className="font-medium">
          {m.ready
            ? m.simulated && m.mode !== 'own'
              ? 'Test mode: cards go to the payment simulator'
              : `Taking cards with ${ownOn ? 'your own Stripe account' : 'Ample POS payments'}`
            : 'Not taking cards yet'}
        </p>
        {m.message && <p className="text-sm">{m.message}</p>}
        {onboarding === 'retry' && <p className="text-sm">The Stripe link expired. Continue setup to get a fresh one.</p>}
      </section>

      <section className={`card space-y-3 ${platformOn ? 'border-brand' : ''}`}>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-medium">Ample POS payments</h2>
          <span className="text-xs text-stone-500">Recommended · powered by Stripe</span>
        </div>
        <p className="text-sm text-stone-600">
          Stripe sets up an account for your business in a few minutes: your details, a bank account for payouts and an ID check, on Stripe’s secure form. Money goes straight to your bank. Ample POS takes
          no fee; Stripe’s standard card fees apply.
        </p>
        {platformOn && m.platform && (
          <div className="rounded-md bg-stone-50 p-3 text-sm">
            <p>
              Taking cards: <strong>{m.platform.chargesEnabled ? 'yes' : 'not yet'}</strong> · Payouts to your bank: <strong>{m.platform.payoutsEnabled ? 'yes' : 'not yet'}</strong>
            </p>
            {m.platform.requirementsDue.length > 0 && <p className="mt-1">Stripe still needs: {m.platform.requirementsDue.map(due).join(', ')}.</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <ActionForm action={startPlatform.bind(null, tenantId)}>
            <button className={platformOn ? 'btn-secondary' : 'btn'}>
              {platformOn ? (m.platform?.requirementsDue.length || !m.platform?.chargesEnabled ? 'Continue setup with Stripe' : 'Update details with Stripe') : m.platform ? 'Switch back to Ample POS payments' : 'Set up with Stripe'}
            </button>
          </ActionForm>
          {platformOn && m.platform?.chargesEnabled && !m.simulated && (
            <ActionForm action={openDashboard.bind(null, tenantId)}>
              <button className="btn-secondary">Payouts and balance (Stripe)</button>
            </ActionForm>
          )}
          {(platformOn || ownOn) && (
            <ActionForm action={refreshMerchant.bind(null, tenantId)}>
              <button className="btn-secondary">Check status</button>
            </ActionForm>
          )}
        </div>
      </section>

      <section className={`card space-y-3 ${ownOn ? 'border-brand' : ''}`}>
        <h2 className="font-medium">Use your own Stripe account</h2>
        <p className="text-sm text-stone-600">Already have Stripe? Connect it with a secret key from Stripe → Developers → API keys. The key is stored encrypted and never shown again.</p>
        {ownOn && m.own && (
          <div className="rounded-md bg-stone-50 p-3 text-sm">
            Connected: <strong>{m.own.businessName ?? m.own.accountId}</strong> ({m.own.accountId}) · {m.own.livemode ? 'live' : 'test mode'}
            {!m.own.webhookConfigured && <p className="mt-1 text-amber-800">Add a webhook (below) so payments finished on the reader update right away.</p>}
          </div>
        )}
        {m.ownKeysSupported ? (
          <ActionForm action={connectOwn.bind(null, tenantId)} className="space-y-2">
            <input name="secretKey" placeholder="sk_live_… or rk_live_…" required autoComplete="off" className="input" />
            <input name="webhookSecret" placeholder="Webhook signing secret, whsec_… (optional)" autoComplete="off" className="input" />
            <p className="text-xs text-stone-500">
              For the webhook, add an endpoint in Stripe → Developers → Webhooks at <code className="break-all">{m.ownWebhookUrl}</code> for the events payment_intent.succeeded,
              payment_intent.payment_failed and payment_intent.canceled, then paste its signing secret here.
            </p>
            <button className={ownOn ? 'btn-secondary' : 'btn'}>{ownOn ? 'Replace key' : 'Connect my Stripe account'}</button>
          </ActionForm>
        ) : (
          <p className="text-sm text-stone-500">Not available on this server yet (it needs SECRETS_KEY).</p>
        )}
      </section>

      {(platformOn || ownOn) && (
        <ActionForm action={turnOffCards.bind(null, tenantId)} className="card space-y-2 border-red-200">
          <h2 className="font-medium">Stop taking cards</h2>
          <p className="text-sm text-stone-600">Registers stop offering card payments. Earlier card sales can still be refunded, and you can turn cards back on without setting up again.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" /> Turn off card payments
          </label>
          <button className="btn-secondary text-red-700">Turn off</button>
        </ActionForm>
      )}
    </div>
  );
}

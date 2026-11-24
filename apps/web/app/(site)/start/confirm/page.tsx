import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { readPendingSetup } from '@/lib/site';
import type { Me } from '@/lib/types';
import { resendVerification } from '../../../session-actions';
import { finishSetup, forgetSetup } from '../../../start-actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Confirm your email · Ample POS' };

/** Between signup and the new business: the account confirms its email first. */
export default async function ConfirmPage() {
  const setup = await readPendingSetup();
  if (!setup) redirect('/businesses');
  const me = await api<Me>('/me');
  const verified = me.account.emailVerified;
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{verified ? 'Email confirmed' : 'Check your email'}</h1>
      {verified ? (
        <p className="mt-3 text-stone-600">
          Thanks. Finish setting up <strong>{setup.business}</strong>.
        </p>
      ) : (
        <p className="mt-3 text-stone-600">
          We sent a link to <strong>{me.user.email}</strong>. Open it to confirm your address, then come back here to finish setting up <strong>{setup.business}</strong>.
        </p>
      )}
      <ActionForm action={finishSetup} className="card mt-8 space-y-3">
        <p className="text-sm text-stone-600">
          {setup.business} · {setup.plan[0]!.toUpperCase() + setup.plan.slice(1)} plan
          {setup.website ? ' · online store' : ''} · {setup.subscribe ? 'subscribe now' : 'free trial'}
        </p>
        <button className="btn">{verified ? 'Finish setup' : 'I’ve confirmed it, finish setup'}</button>
      </ActionForm>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        {!verified && (
          <ActionForm action={resendVerification}>
            <button className="text-brand hover:underline">Send the link again</button>
          </ActionForm>
        )}
        <form action={forgetSetup}>
          <button className="text-stone-500 hover:underline">Skip, go to my account</button>
        </form>
        <Link href="/pricing" className="text-stone-500 hover:underline">
          Back to pricing
        </Link>
      </div>
    </main>
  );
}

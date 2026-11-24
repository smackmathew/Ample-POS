import Link from 'next/link';
import { api } from '@/lib/api';
import { SEVERITY, utc, type Issue } from '@/lib/platform';

const HINT: Record<string, string> = {
  billing: 'Stripe is retrying the subscription payment. Reach out to the owner to update their card.',
  trial: 'Their paid tools are read-only. Offer help subscribing, or make a tool free for them.',
  'card-failed': 'Several card payments were declined or errored. Check their card reader and Stripe account.',
  'card-stuck': 'A card payment never finished. Ask them to cancel it on the register or check the reader.',
  'refund-failed': 'The processor refused a refund. Check the payment in Stripe.',
  outbox: 'A background job keeps failing (billing sync, store sync…). The error shows what went wrong.',
  integration: 'Their Shopify connection stopped working. They may need to reconnect it.',
  'sync-issues': 'Products or orders couldn’t sync with their online store.',
  'register-open': 'A register has been open for over a day; the drawer count may be off.',
};

export default async function IssuesPage() {
  const issues = await api<Issue[]>('/platform/issues');
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">Issues</h1>
      <p className="text-stone-600">Problems found across all companies, worst first. They clear by themselves once fixed.</p>
      {issues.length === 0 && <p className="card text-stone-600">Nothing needs attention.</p>}
      <div className="space-y-2">
        {issues.map((i) => (
          <Link key={i.key} href={`/platform/companies/${i.tenantId}`} className="card block space-y-1 hover:border-brand">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={`rounded px-2 py-0.5 text-xs ${SEVERITY[i.severity]}`}>{i.severity}</span>
              <span className="font-medium">{i.title}</span>
              <span className="text-stone-500">· {i.tenantName}</span>
              <span className="ml-auto text-xs text-stone-400">since {utc(i.since)}</span>
            </div>
            {i.detail && <p className="text-sm text-stone-700">{i.detail}</p>}
            <p className="text-xs text-stone-500">{HINT[i.key.split(':')[0]!]}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

import { headers } from 'next/headers';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDateTime, homeTimeZone } from '@/lib/time';
import type { Location, ModuleSummary } from '@/lib/types';
import {
  createApiKey,
  createWebhook,
  deleteWebhook,
  retryDelivery,
  revokeApiKey,
  rotateWebhookSecret,
  setWebhookActive,
  testWebhook,
} from '../developer-actions';

interface ApiKeyRow {
  id: string;
  name: string;
  hint: string;
  permissions: string[];
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: { name: string | null; email: string | null };
}
interface WebhookRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  pending: number;
  failed: number;
  lastDeliveredAt: string | null;
}
interface Delivery {
  id: number;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
}
interface EventType {
  type: string;
  description: string;
}

const BUSINESS_PERMISSIONS = [
  { key: 'locations.manage', description: 'Create and edit locations' },
  { key: 'members.read', description: 'View team members' },
  { key: 'audit.read', description: 'View the audit log' },
];

const STATUS: Record<Delivery['status'], string> = {
  delivered: 'bg-brand-soft text-brand',
  pending: 'bg-amber-50 text-amber-800',
  failed: 'bg-red-50 text-red-700',
};

export default async function DevelopersPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [keys, webhooks, modules, types, locations] = await Promise.all([
    api<ApiKeyRow[]>('/api-keys', { tenantId }),
    api<WebhookRow[]>('/webhooks', { tenantId }),
    api<ModuleSummary[]>('/modules', { tenantId }),
    api<EventType[]>('/events/types', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
  ]);
  const deliveries = await Promise.all(webhooks.map((w) => api<Delivery[]>(`/webhooks/${w.id}/deliveries?limit=5`, { tenantId })));
  const zone = homeTimeZone(locations);
  const when = (iso: string | null) => (iso ? formatDateTime(iso, zone) : 'Never');
  const groups = [{ name: 'Business', permissions: BUSINESS_PERMISSIONS }, ...modules.filter((m) => m.enabled).map((m) => ({ name: m.name, permissions: m.permissions }))];
  const base = await publicApiBase();

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">API & webhooks</h1>
        <p className="mt-1 max-w-3xl text-stone-600">
          Let another app, such as your own hub, an ERP or an online store, read this business’s data and push products and stock in. Ample POS can also tell it the moment
          something changes.{' '}
          <Link href="/developers" className="text-brand hover:underline">
            Read the API guide →
          </Link>
        </p>
      </header>

      <section className="card grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm text-stone-500">API address</p>
          <code className="mt-1 block rounded-lg bg-stone-50 px-3 py-2 text-sm break-all">{base}</code>
        </div>
        <div>
          <p className="text-sm text-stone-500">Business ID</p>
          <code className="mt-1 block rounded-lg bg-stone-50 px-3 py-2 text-sm break-all">{tenantId}</code>
        </div>
        <div className="sm:col-span-2">
          <p className="text-sm text-stone-500">Try it</p>
          <code className="mt-1 block rounded-lg bg-stone-900 px-3 py-2 text-sm break-all text-stone-100">
            curl {base}/catalog/products -H &quot;Authorization: Bearer YOUR_API_KEY&quot;
          </code>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">API keys</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-stone-500">
              <tr>
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Access</th>
                <th className="px-5 py-3">Created by</th>
                <th className="px-5 py-3">Last used</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={`border-t border-stone-100 ${k.revokedAt ? 'text-stone-400' : ''}`}>
                  <td className="px-5 py-3">
                    <div className="font-medium">{k.name}</div>
                    <code className="text-xs text-stone-500">{k.hint}</code>
                  </td>
                  <td className="px-5 py-3">
                    {k.readOnly ? 'Read only' : 'Read and write'}
                    <div className="text-xs text-stone-500">{k.permissions.includes('*') ? 'Everything' : `${k.permissions.length} permission${k.permissions.length === 1 ? '' : 's'}`}</div>
                  </td>
                  <td className="px-5 py-3">{k.createdBy.name ?? k.createdBy.email}</td>
                  <td className="px-5 py-3">{k.revokedAt ? `Revoked ${when(k.revokedAt)}` : when(k.lastUsedAt)}</td>
                  <td className="px-5 py-3 text-right">
                    {!k.revokedAt && (
                      <form action={revokeApiKey.bind(null, tenantId, k.id)}>
                        <button className="text-xs text-red-700 hover:underline">Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-stone-500">
                    No API keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <ActionForm action={createApiKey.bind(null, tenantId)} className="card grid gap-4" secretLabel="Copy this key now and give it to the other app. It won’t be shown again.">
          <h3 className="font-semibold">Create an API key</h3>
          <label className="block text-sm sm:max-w-sm">
            Name
            <input name="name" required maxLength={80} placeholder="e.g. Client hub" className="input mt-1" />
          </label>
          <fieldset className="text-sm">
            <legend className="font-medium">Access</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="access" value="write" defaultChecked className="accent-brand" /> Read and write
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="access" value="read" className="accent-brand" /> Read only
              </label>
            </div>
          </fieldset>
          <fieldset className="text-sm">
            <legend className="font-medium">Areas</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="all" defaultChecked className="accent-brand" /> Everything you can do
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="some" className="accent-brand" /> Only what’s ticked below
              </label>
            </div>
            <details className="mt-3 rounded-xl border border-stone-200 p-4">
              <summary className="cursor-pointer text-stone-600">Choose areas</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((g) => (
                  <div key={g.name}>
                    <p className="font-medium">{g.name}</p>
                    {g.permissions.map((p) => (
                      <label key={p.key} className="mt-1 flex items-start gap-2 text-stone-700">
                        <input type="checkbox" name="permissions" value={p.key} className="mt-1 accent-brand" />
                        {p.description}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          </fieldset>
          <p className="text-xs text-stone-500">
            A key acts on your behalf, never with more than you’re allowed. If you leave the business, your keys stop working. Keys can’t create other keys.
          </p>
          <button className="btn justify-self-start">Create key</button>
        </ActionForm>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Webhooks</h2>
        <p className="max-w-3xl text-sm text-stone-600">
          Ample POS sends a signed POST to each address when something happens. Failed deliveries are retried for about a day. The other app can also catch up any time
          from the change feed.
        </p>
        {webhooks.map((w, i) => (
          <div key={w.id} className="card space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <code className="block text-sm break-all">{w.url}</code>
                {w.description && <p className="text-sm text-stone-500">{w.description}</p>}
                <p className="mt-1 text-xs text-stone-500">
                  {w.events.includes('*') ? 'All events' : w.events.join(', ')} · last delivered {when(w.lastDeliveredAt)}
                  {w.failed > 0 && <span className="text-red-700"> · {w.failed} failed this week</span>}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${w.active ? 'bg-brand-soft text-brand' : 'bg-stone-100 text-stone-600'}`}>
                {w.active ? 'On' : 'Paused'}
              </span>
            </div>
            {deliveries[i]!.length > 0 && (
              <table className="w-full text-sm">
                <tbody>
                  {deliveries[i]!.map((d) => (
                    <tr key={d.id} className="border-t border-stone-100">
                      <td className="py-2">{d.type}</td>
                      <td className="py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[d.status]}`}>{d.status}</span>
                      </td>
                      <td className="py-2 text-xs text-stone-500">
                        {d.lastError ?? (d.responseStatus ? `HTTP ${d.responseStatus}` : '')} {d.attempts > 1 ? `· ${d.attempts} tries` : ''}
                      </td>
                      <td className="py-2 text-xs text-stone-500">{when(d.createdAt)}</td>
                      <td className="py-2 text-right">
                        {d.status !== 'delivered' && (
                          <form action={retryDelivery.bind(null, tenantId, d.id)}>
                            <button className="text-xs text-brand hover:underline">Retry now</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="flex flex-wrap items-start gap-2">
              <ActionForm action={testWebhook.bind(null, tenantId, w.id)}>
                <button className="btn-secondary">Send test event</button>
              </ActionForm>
              <ActionForm action={rotateWebhookSecret.bind(null, tenantId, w.id)} secretLabel="The new signing secret. It won’t be shown again.">
                <button className="btn-secondary">New signing secret</button>
              </ActionForm>
              <form action={setWebhookActive.bind(null, tenantId, w.id, !w.active)}>
                <button className="btn-secondary">{w.active ? 'Pause' : 'Turn on'}</button>
              </form>
              <form action={deleteWebhook.bind(null, tenantId, w.id)}>
                <button className="btn-secondary text-red-700">Delete</button>
              </form>
            </div>
          </div>
        ))}

        <ActionForm action={createWebhook.bind(null, tenantId)} className="card grid gap-4" secretLabel="Signing secret: copy it into the other app now. It won’t be shown again.">
          <h3 className="font-semibold">Add a webhook</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              Address (https://)
              <input name="url" type="url" required placeholder="https://hub.example.com/ample" className="input mt-1" />
            </label>
            <label className="block text-sm">
              Description (optional)
              <input name="description" maxLength={200} placeholder="Client hub" className="input mt-1" />
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="font-medium">Events</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="which" value="all" defaultChecked className="accent-brand" /> All events
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="which" value="some" className="accent-brand" /> Only what’s ticked below
              </label>
            </div>
            <details className="mt-3 rounded-xl border border-stone-200 p-4">
              <summary className="cursor-pointer text-stone-600">Choose events</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {types.map((t) => (
                  <label key={t.type} className="flex items-start gap-2">
                    <input type="checkbox" name="events" value={t.type} className="mt-1 accent-brand" />
                    <span>
                      <code className="text-xs">{t.type}</code>
                      <span className="block text-xs text-stone-500">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </details>
          </fieldset>
          <button className="btn justify-self-start">Add webhook</button>
        </ActionForm>
      </section>
    </div>
  );
}

/** Where other apps reach the API: PUBLIC_API_URL if set, else this site's /api (the web app forwards it). */
async function publicApiBase(): Promise<string> {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api`;
}

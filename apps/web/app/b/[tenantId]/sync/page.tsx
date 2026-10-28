import { ActionForm } from '@/components/action-form';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/time';
import type { Location } from '@/lib/types';
import { connectShopify, disconnectShopify, linkLocation, resolveIssue, runSync, saveOrderLocation, startShopifyConnect } from '../sync-actions';

interface Status {
  connected: boolean;
  oauthEnabled?: boolean;
  method?: 'oauth' | 'token';
  id?: string;
  shopDomain?: string;
  status?: 'active' | 'error';
  statusMessage?: string | null;
  lastImportAt?: string | null;
  lastPushAt?: string | null;
  ordersCheckedAt?: string | null;
  settings?: { onlineOrdersLocationId?: string };
  webhookUrl?: string | null;
  counts?: { products: number; variants: number; locations: number; openIssues: number };
}

interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
  locationId: string | null;
}

interface Issue {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
}

export default async function SyncPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { tenantId } = await params;
  const { connected, error } = await searchParams;
  const [status, locations] = await Promise.all([api<Status>('/integrations/shopify', { tenantId }), api<Location[]>('/locations', { tenantId })]);

  // Sync activity isn't tied to a location; show it in the business's main time zone.
  const tz = locations[0]?.timezone || 'UTC';
  const when = (iso?: string | null) => (iso ? formatDateTime(iso, tz) : 'never');

  if (!status.connected) return <Connect tenantId={tenantId} oauthEnabled={Boolean(status.oauthEnabled)} error={error} />;

  let remote: ShopifyLocation[] = [];
  let remoteError = '';
  try {
    remote = await api<ShopifyLocation[]>('/integrations/shopify/locations', { tenantId });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    remoteError = err.message;
  }
  const issues = await api<Issue[]>('/integrations/shopify/issues', { tenantId });
  const action = (a: 'import' | 'push' | 'reconcile' | 'webhooks', label: string, primary = false) => (
    <ActionForm action={runSync.bind(null, tenantId, a)}>
      <button className={primary ? 'btn' : 'btn-secondary'}>{label}</button>
    </ActionForm>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Website sync</h1>
      {connected && (
        <p className="card border-teal-200 bg-teal-50 text-sm">
          Store connected. Next: import products, link locations, then turn on live updates.
        </p>
      )}

      <section className={`card space-y-3 ${status.status === 'error' ? 'border-red-300' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">Shopify · {status.shopDomain}</p>
            <p className={`text-sm ${status.status === 'error' ? 'text-red-700' : 'text-stone-500'}`}>{status.statusMessage}</p>
          </div>
          <form action={disconnectShopify.bind(null, tenantId)}>
            <button className="text-sm text-red-700 hover:underline">Disconnect</button>
          </form>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Stat label="Products linked" value={`${status.counts!.products} (${status.counts!.variants} variants)`} />
          <Stat label="Locations linked" value={String(status.counts!.locations)} />
          <Stat label="Last product import" value={when(status.lastImportAt)} />
          <Stat label="Last stock update sent" value={when(status.lastPushAt)} />
          <Stat label="Online orders checked" value={when(status.ordersCheckedAt)} />
          <Stat label="Webhook address" value={status.webhookUrl ?? 'set PUBLIC_API_URL on the server'} />
        </dl>
        <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
          {action('import', 'Import products from Shopify', true)}
          {action('push', 'Send stock to Shopify')}
          {action('reconcile', 'Check for missed orders')}
          {status.webhookUrl && action('webhooks', 'Turn on live updates')}
        </div>
        <p className="text-xs text-stone-500">
          Shopify is the source for product names, variants, SKUs, barcodes and prices. Ample POS is the source for stock counts at linked locations. Online
          orders reduce stock here at the location you choose below.
        </p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Locations</h2>
        <p className="text-sm text-stone-600">
          Link each Shopify location to the Ample POS location whose stock it should show. The first time an item is linked we start from Shopify’s
          count; after that, counts from Ample POS are sent to Shopify.
        </p>
        {remoteError && <p className="text-sm text-red-700">{remoteError}</p>}
        <ul className="divide-y divide-stone-100">
          {remote.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className={l.isActive ? '' : 'text-stone-400'}>
                {l.name}
                {!l.isActive && ' (inactive)'}
              </span>
              <ActionForm action={linkLocation.bind(null, tenantId, l.id)} className="flex items-center gap-2">
                <select name="locationId" defaultValue={l.locationId ?? ''} className="input w-48">
                  <option value="">Not linked</option>
                  {locations.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="btn-secondary">Save</button>
              </ActionForm>
            </li>
          ))}
        </ul>
        <ActionForm action={saveOrderLocation.bind(null, tenantId)} className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
          <label className="text-sm" htmlFor="orders-location">
            Online orders take stock from
          </label>
          <select id="orders-location" name="locationId" defaultValue={status.settings?.onlineOrdersLocationId ?? ''} className="input w-48">
            <option value="">Don’t record online orders</option>
            {locations.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary">Save</button>
        </ActionForm>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Needs attention</h2>
        <ul className="card divide-y divide-stone-100 text-sm">
          {issues.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-2">
              <span>
                {i.message}
                <span className="block text-xs text-stone-400">{when(i.createdAt)}</span>
              </span>
              <form action={resolveIssue.bind(null, tenantId, i.id)}>
                <button className="text-xs text-stone-500 hover:underline">Dismiss</button>
              </form>
            </li>
          ))}
          {issues.length === 0 && <li className="py-2 text-stone-500">Nothing needs attention.</li>}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 sm:block">
      <dt className="text-stone-500">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

function Connect({ tenantId, oauthEnabled, error }: { tenantId: string; oauthEnabled: boolean; error?: string }) {
  const tokenForm = (
    <ActionForm action={connectShopify.bind(null, tenantId)} className="space-y-3">
      <p className="text-sm text-stone-600">
        For a store that already has a custom app created in the Shopify admin (Settings → Apps → Develop apps) with the scopes{' '}
        <code>read_products</code>, <code>read_orders</code>, <code>read_locations</code>, <code>read_inventory</code> and <code>write_inventory</code>.
        Shopify no longer allows new apps to be created this way.
      </p>
      <label className="block text-sm">
        Store address
        <input name="shopDomain" placeholder="your-store.myshopify.com" required className="input mt-1" />
      </label>
      <label className="block text-sm">
        Admin API access token
        <input name="accessToken" type="password" autoComplete="off" required className="input mt-1" />
      </label>
      <label className="block text-sm">
        API secret key (used to check Shopify’s notifications)
        <input name="webhookSecret" type="password" autoComplete="off" required className="input mt-1" />
      </label>
      <p className="text-xs text-stone-500">Both keys are encrypted before they are stored and are never shown again.</p>
      <button className={oauthEnabled ? 'btn-secondary' : 'btn'}>Connect with token</button>
    </ActionForm>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Website sync</h1>
      {error && <p className="card border-red-200 bg-red-50 text-sm text-red-800">{error}</p>}
      {oauthEnabled ? (
        <>
          <ActionForm action={startShopifyConnect.bind(null, tenantId)} className="card space-y-3">
            <h2 className="font-medium">Connect your Shopify store</h2>
            <p className="text-sm text-stone-600">
              You’ll be sent to Shopify to approve access to products, orders, locations and inventory, then brought back here.
            </p>
            <label className="block text-sm">
              Store address
              <input name="shopDomain" placeholder="your-store.myshopify.com" required className="input mt-1" />
            </label>
            <button className="btn">Connect with Shopify</button>
          </ActionForm>
          <details className="card">
            <summary className="cursor-pointer text-sm font-medium">Use an existing custom app token instead</summary>
            <div className="mt-3">{tokenForm}</div>
          </details>
        </>
      ) : (
        <section className="card space-y-3">
          <h2 className="font-medium">Connect your Shopify store</h2>
          <p className="text-sm text-amber-800">
            “Connect with Shopify” isn’t set up on this server yet (it needs SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from Ample POS’s Shopify app).
          </p>
          {tokenForm}
        </section>
      )}
    </div>
  );
}

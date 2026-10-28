'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';
import { SHOPIFY_OAUTH_COOKIE } from '@/lib/shopify';

const path = (tenantId: string) => `/b/${tenantId}/sync`;
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export async function connectShopify(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/integrations/shopify/connect', {
      tenantId,
      method: 'POST',
      body: { shopDomain: str(form, 'shopDomain'), accessToken: str(form, 'accessToken'), webhookSecret: str(form, 'webhookSecret') },
    });
    revalidatePath(path(tenantId));
  });
}

/** "Connect with Shopify": remember the flow in a short-lived cookie and go to Shopify's approval page. */
export async function startShopifyConnect(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let url: string | undefined;
  const result = await attempt(async () => {
    const start = await api<{ authorizeUrl: string; nonce: string }>('/integrations/shopify/oauth/start', {
      tenantId,
      method: 'POST',
      body: { shopDomain: str(form, 'shopDomain') },
    });
    (await cookies()).set(SHOPIFY_OAUTH_COOKIE, `${tenantId}.${start.nonce}`, {
      httpOnly: true,
      // Lax so the cookie comes back on Shopify's top-level redirect.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/shopify/callback',
      maxAge: 10 * 60,
    });
    url = start.authorizeUrl;
  });
  if (result?.error) return result;
  redirect(url!);
}

export async function disconnectShopify(tenantId: string) {
  await api('/integrations/shopify', { tenantId, method: 'DELETE' });
  revalidatePath(path(tenantId));
}

type SyncAction = 'import' | 'push' | 'reconcile' | 'webhooks';

const describe: Record<SyncAction, (r: never) => string> = {
  import: (r: { products: number; created: number; updated: number; matched: number; skipped: number }) =>
    `Imported ${r.products} products: ${r.created} new, ${r.matched} matched by SKU, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}.`,
  push: (r: { seeded: number; pushed: number; unchanged: number; conflicts: number; failed: number }) =>
    `Stock sent: ${r.pushed} updated, ${r.unchanged} already right${r.seeded ? `, ${r.seeded} started from Shopify's count` : ''}${r.conflicts ? `, ${r.conflicts} changed in Shopify meanwhile (will retry)` : ''}${r.failed ? `, ${r.failed} failed` : ''}.`,
  reconcile: (r: { orders: number; stock: { pushed: number } }) => `Checked ${r.orders} recent online orders and updated ${r.stock.pushed} stock levels.`,
  webhooks: (r: { topic: string; ok: boolean; error: string | null }[]) =>
    r.every((x) => x.ok) ? 'Shopify will now notify us of product and order changes.' : `Some webhooks failed: ${r.filter((x) => !x.ok).map((x) => `${x.topic} (${x.error})`).join(', ')}`,
};

export async function runSync(tenantId: string, action: SyncAction, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const result = await api(`/integrations/shopify/${action}`, { tenantId, method: 'POST' });
    revalidatePath(path(tenantId));
    return { ok: (describe[action] as (r: unknown) => string)(result) };
  });
}

export async function linkLocation(tenantId: string, shopifyLocationId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/integrations/shopify/locations/${encodeURIComponent(shopifyLocationId)}`, {
      tenantId,
      method: 'PUT',
      body: { locationId: str(form, 'locationId') || null },
    });
    revalidatePath(path(tenantId));
  });
}

export async function saveOrderLocation(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/integrations/shopify/settings', { tenantId, method: 'PUT', body: { onlineOrdersLocationId: str(form, 'locationId') || null } });
    revalidatePath(path(tenantId));
  });
}

export async function resolveIssue(tenantId: string, id: number) {
  await api(`/integrations/shopify/issues/${id}/resolve`, { tenantId, method: 'POST' });
  revalidatePath(path(tenantId));
}

'use server';

import { revalidatePath } from 'next/cache';
import { api, attempt, type ActionState } from '@/lib/api';

const page = (tenantId: string) => `/b/${tenantId}/developers`;

export async function createApiKey(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const scope = String(form.get('scope') ?? 'all');
  const permissions = scope === 'all' ? ['*'] : form.getAll('permissions').map(String);
  if (!permissions.length) return { error: 'Pick at least one area, or choose Everything' };
  return attempt(async () => {
    const created = await api<{ key: string }>('/api-keys', {
      tenantId,
      method: 'POST',
      body: { name: String(form.get('name') ?? '').trim(), permissions, readOnly: form.get('access') === 'read' },
    });
    revalidatePath(page(tenantId));
    return { ok: 'Key created. Give it to the other app now.', secret: created.key };
  });
}

export async function revokeApiKey(tenantId: string, id: string) {
  await api(`/api-keys/${id}/revoke`, { tenantId, method: 'POST' });
  revalidatePath(page(tenantId));
}

export async function createWebhook(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const events = form.get('which') === 'some' ? form.getAll('events').map(String) : ['*'];
  if (!events.length) return { error: 'Pick at least one event, or choose All events' };
  return attempt(async () => {
    const created = await api<{ secret: string }>('/webhooks', {
      tenantId,
      method: 'POST',
      body: { url: String(form.get('url') ?? '').trim(), events, description: String(form.get('description') ?? '').trim() || undefined },
    });
    revalidatePath(page(tenantId));
    return { ok: 'Webhook added. Use this signing secret to check each request really came from Ample POS.', secret: created.secret };
  });
}

export async function setWebhookActive(tenantId: string, id: string, active: boolean) {
  await api(`/webhooks/${id}`, { tenantId, method: 'PATCH', body: { active } });
  revalidatePath(page(tenantId));
}

export async function deleteWebhook(tenantId: string, id: string) {
  await api(`/webhooks/${id}`, { tenantId, method: 'DELETE' });
  revalidatePath(page(tenantId));
}

export async function testWebhook(tenantId: string, id: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api(`/webhooks/${id}/test`, { tenantId, method: 'POST' });
    revalidatePath(page(tenantId));
    return { ok: 'Test event queued. It arrives within a few seconds; refresh to see the result.' };
  });
}

export async function rotateWebhookSecret(tenantId: string, id: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const { secret } = await api<{ secret: string }>(`/webhooks/${id}/rotate-secret`, { tenantId, method: 'POST' });
    return { ok: 'New secret made. The old one no longer works; update the other app now.', secret };
  });
}

export async function retryDelivery(tenantId: string, deliveryId: number) {
  await api(`/webhooks/deliveries/${deliveryId}/retry`, { tenantId, method: 'POST' });
  revalidatePath(page(tenantId));
}

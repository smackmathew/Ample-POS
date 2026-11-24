'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';

export async function startPlatform(tenantId: string, _: ActionState): Promise<ActionState> {
  let url = '';
  const result = await attempt(async () => {
    url = (await api<{ url: string }>('/payments/merchant/platform', { tenantId, method: 'POST' })).url;
  });
  if (result?.error) return result;
  redirect(url);
}

export async function openDashboard(tenantId: string, _: ActionState): Promise<ActionState> {
  let url = '';
  const result = await attempt(async () => {
    url = (await api<{ url: string }>('/payments/merchant/dashboard', { tenantId, method: 'POST' })).url;
  });
  if (result?.error) return result;
  redirect(url);
}

export async function refreshMerchant(tenantId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api('/payments/merchant/refresh', { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}/payments`);
    return { ok: 'Status updated from Stripe' };
  });
}

export async function connectOwn(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/payments/merchant/own', {
      tenantId,
      method: 'PUT',
      body: { secretKey: String(form.get('secretKey') ?? ''), webhookSecret: String(form.get('webhookSecret') ?? '') },
    });
    revalidatePath(`/b/${tenantId}/payments`);
    return { ok: 'Your Stripe account is connected' };
  });
}

export async function turnOffCards(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (form.get('confirm') !== 'on') return { error: 'Tick the box to confirm' };
  return attempt(async () => {
    await api('/payments/merchant/off', { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}/payments`);
    return { ok: 'Card payments are off. Cash and gift cards still work.' };
  });
}

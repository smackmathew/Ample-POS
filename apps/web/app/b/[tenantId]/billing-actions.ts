'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';

/** Subscribe: Stripe sends the owner to Checkout; the simulated provider subscribes on the spot. */
export async function startCheckout(tenantId: string): Promise<ActionState> {
  let url: string | undefined;
  const result = await attempt(async () => {
    const res = await api<{ url?: string; subscribed?: true }>('/billing/checkout', { tenantId, method: 'POST' });
    url = res.url;
    revalidatePath(`/b/${tenantId}`, 'layout');
    return { ok: 'Subscribed. Thank you!' };
  });
  if (result?.error || !url) return result;
  redirect(url);
}

/** Stripe's customer portal: invoices, payment method, cancellation. */
export async function openPortal(tenantId: string): Promise<ActionState> {
  let url: string | undefined;
  const result = await attempt(async () => {
    url = (await api<{ url: string }>('/billing/portal', { tenantId, method: 'POST' })).url;
  });
  if (result?.error) return result;
  redirect(url!);
}

export async function setCancel(tenantId: string, cancel: boolean): Promise<ActionState> {
  return attempt(async () => {
    await api(`/billing/${cancel ? 'cancel' : 'resume'}`, { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}`, 'layout');
    return { ok: cancel ? 'Your subscription will end at the close of this billing period.' : 'Your subscription will continue.' };
  });
}

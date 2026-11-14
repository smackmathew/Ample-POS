'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';

export async function issueGiftCard(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const amountMinor = parseMoney(String(form.get('amount') ?? ''));
  if (!amountMinor) return { error: 'Enter the amount, like 25.00' };
  let id = '';
  const result = await attempt(async () => {
    const code = String(form.get('code') ?? '').trim();
    id = (await api<{ id: string }>('/gift-cards', { tenantId, method: 'POST', body: { amountMinor, code: code || undefined, note: String(form.get('note') ?? '') } })).id;
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/gift-cards/${id}`);
}

export async function adjustGiftCard(tenantId: string, cardId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const raw = String(form.get('amount') ?? '').trim();
  const negative = raw.startsWith('-') || raw.startsWith('−');
  const amount = parseMoney(raw.replace(/^[-−]/, ''));
  if (!amount) return { error: 'Enter an amount to add, or a negative amount to take off' };
  const amountMinor = negative ? -amount : amount;
  return attempt(async () => {
    await api(`/gift-cards/${cardId}/adjust`, { tenantId, method: 'POST', body: { amountMinor, note: String(form.get('note') ?? '') } });
    revalidatePath(`/b/${tenantId}/gift-cards/${cardId}`);
    return { ok: 'Balance updated' };
  });
}

export async function voidGiftCard(tenantId: string, cardId: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (form.get('confirm') !== 'on') return { error: 'Tick the box to confirm' };
  return attempt(async () => {
    await api(`/gift-cards/${cardId}/void`, { tenantId, method: 'POST', body: { note: String(form.get('note') ?? '') } });
    revalidatePath(`/b/${tenantId}/gift-cards/${cardId}`);
    return { ok: 'Card voided' };
  });
}

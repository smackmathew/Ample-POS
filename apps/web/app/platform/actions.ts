'use server';

import { revalidatePath } from 'next/cache';
import { api, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';

export async function setCompanyTool(companyId: string, moduleId: string, change: { enabled?: boolean; comped?: boolean; blocked?: boolean }): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/tools/${moduleId}`, { method: 'PUT', body: change });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Saved' };
  });
}

export async function suspendCompany(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/suspend`, { method: 'POST', body: { reason: String(form.get('reason') ?? '') } });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Suspended. Everyone in the business is locked out until you restore it.' };
  });
}

export async function restoreCompany(companyId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/restore`, { method: 'POST' });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Restored' };
  });
}

export async function setPlatformTool(moduleId: string, change: { available?: boolean }): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/tools/${moduleId}`, { method: 'PUT', body: change });
    revalidatePath('/platform/tools');
    return { ok: 'Saved' };
  });
}

export async function setPlatformPrice(moduleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const raw = String(form.get('price') ?? '').trim();
  const monthlyPriceMinor = raw === '' ? null : parseMoney(raw);
  if (raw !== '' && monthlyPriceMinor === null) return { error: 'Enter a price like 9.00, or leave it empty for the built-in price' };
  return attempt(async () => {
    await api(`/platform/tools/${moduleId}`, { method: 'PUT', body: { monthlyPriceMinor } });
    revalidatePath('/platform/tools');
    return { ok: monthlyPriceMinor === null ? 'Back to the built-in price' : 'Price saved. Subscriptions update shortly.' };
  });
}

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

export async function cardPaymentsOff(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/card-payments/off`, { method: 'POST', body: { reason: String(form.get('reason') ?? '') } });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Card payments are off for this business' };
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

const moneyField = (form: FormData, key: string) => {
  const raw = String(form.get(key) ?? '').trim();
  if (raw === '') return null;
  const v = parseMoney(raw);
  if (v === null) throw new Error(`Enter an amount like 39.00 for ${key}`);
  return v;
};

export async function setPlanPrices(planId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let body;
  try {
    const registers = String(form.get('registers') ?? '').trim();
    body = {
      baseMinor: moneyField(form, 'base'),
      extraLocationMinor: moneyField(form, 'extra'),
      websiteMaintenanceMinor: moneyField(form, 'maintenance'),
      registersPerLocation: registers ? Number(registers) : null,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
  return attempt(async () => {
    await api(`/platform/plans/${planId}`, { method: 'PUT', body });
    revalidatePath('/platform/tools');
    return { ok: 'Saved. Subscriptions on this plan update shortly.' };
  });
}

export async function setAddonPrice(addonId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let setupMinor;
  try {
    setupMinor = moneyField(form, 'setup');
  } catch (err) {
    return { error: (err as Error).message };
  }
  return attempt(async () => {
    await api(`/platform/website-addons/${addonId}`, { method: 'PUT', body: { setupMinor } });
    revalidatePath('/platform/tools');
    return { ok: 'Saved' };
  });
}

export async function setCompanyPlan(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const website = String(form.get('website') ?? '');
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/plan`, {
      method: 'PUT',
      body: { plan: String(form.get('plan')), websiteAddon: website === 'none' ? null : website },
    });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Saved. Their subscription updates shortly.' };
  });
}

export async function sendTestEmail(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/platform/email/test', { method: 'POST', body: { email: String(form.get('email') ?? '').trim() } });
    return { ok: 'Sent. If it doesn’t arrive within a minute, check spam, then your Resend dashboard (Emails → Logs).' };
  });
}

export async function confirmEmailByHand(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const res = await api<{ alreadyConfirmed: boolean }>('/platform/email/confirm', { method: 'POST', body: { email: String(form.get('email') ?? '').trim() } });
    return { ok: res.alreadyConfirmed ? 'That email was already confirmed.' : 'Confirmed. They can create their business now (refresh their page).' };
  });
}

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';

export async function setCompanyTool(
  companyId: string,
  moduleId: string,
  change: { enabled?: boolean; comped?: boolean; blocked?: boolean },
): Promise<ActionState> {
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
    const res = await api<{ alreadyConfirmed: boolean }>('/platform/email/confirm', {
      method: 'POST',
      body: { email: String(form.get('email') ?? '').trim() },
    });
    return { ok: res.alreadyConfirmed ? 'That email was already confirmed.' : 'Confirmed. They can create their business now (refresh their page).' };
  });
}

// Support view, business edits and people ------------------------------------------------

/** Opens the business read-only, as its owner, and goes there. */
export async function startSupportView(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    await api(`/platform/companies/${companyId}/support`, { method: 'POST', body: { reason: String(form.get('reason') ?? '') } });
  });
  if (result?.error) return result;
  redirect(`/b/${companyId}`);
}

/** Ends the support view and goes back to the company in the dashboard. */
export async function endSupportView(companyId: string): Promise<void> {
  await api(`/platform/companies/${companyId}/support/end`, { method: 'POST' });
  redirect(`/platform/companies/${companyId}`);
}

export async function renameCompany(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/name`, { method: 'PUT', body: { name: String(form.get('name') ?? '') } });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Renamed' };
  });
}

export async function setCompanyTrial(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/companies/${companyId}/trial`, { method: 'PUT', body: { trialEndsAt: String(form.get('trialEndsAt') ?? '') } });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Trial end moved' };
  });
}

export async function setCompanyOwner(companyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const become = String(form.get('previousOwnersBecome') ?? '');
    await api(`/platform/companies/${companyId}/owner`, {
      method: 'POST',
      body: { userId: String(form.get('userId') ?? ''), previousOwnersBecome: become === 'keep' ? null : become },
    });
    revalidatePath(`/platform/companies/${companyId}`);
    return { ok: 'Owner changed' };
  });
}

export async function personAction(userId: string, action: 'confirm-email' | 'two-factor/reset' | 'enable', _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/users/${userId}/${action}`, { method: 'POST' });
    revalidatePath(`/platform/people/${userId}`);
    return {
      ok:
        action === 'confirm-email'
          ? 'Email confirmed'
          : action === 'enable'
            ? 'Account turned back on'
            : 'Two-step sign-in turned off; they’ve been signed out everywhere',
    };
  });
}

export async function disablePerson(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/platform/users/${userId}/disable`, { method: 'POST', body: { reason: String(form.get('reason') ?? '') } });
    revalidatePath(`/platform/people/${userId}`);
    return { ok: 'Account turned off and signed out everywhere' };
  });
}

export async function personResetLink(userId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const res = await api<{ link: string; emailed: boolean }>(`/platform/users/${userId}/password-reset`, { method: 'POST' });
    revalidatePath(`/platform/people/${userId}`);
    return { ok: res.emailed ? 'Emailed to them. You can also pass this link on:' : 'Email isn’t set up, so pass this link on yourself:', secret: res.link };
  });
}

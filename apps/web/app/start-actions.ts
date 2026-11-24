'use server';

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError, attempt, TOKEN_COOKIE, type ActionState } from '@/lib/api';
import { isPlanId, isWebsiteAddonId, readPendingSetup, SETUP_COOKIE, type PendingSetup } from '@/lib/site';

const SESSION_SECONDS = 30 * 24 * 60 * 60;
/** Every plan comes with these on, in dependency order. */
const STARTER_TOOLS = ['catalog', 'pos', 'reporting', 'customers', 'loyalty'];

const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

function readChoice(form: FormData): PendingSetup | { error: string } {
  const business = field(form, 'business');
  const plan = field(form, 'plan');
  const website = field(form, 'website');
  if (!business) return { error: 'Enter your business name' };
  if (business.length > 120) return { error: 'That business name is too long' };
  if (!isPlanId(plan)) return { error: 'Choose a plan' };
  return { business, plan, website: isWebsiteAddonId(website) ? website : null, subscribe: field(form, 'mode') === 'subscribe' };
}

function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

async function keepPendingSetup(setup: PendingSetup) {
  (await cookies()).set(SETUP_COOKIE, JSON.stringify(setup), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

/**
 * Creates the business on the chosen plan with the included tools on, then
 * either opens it (trial) or goes to checkout (subscribe now).
 * Returns null when the email still needs confirming.
 */
async function setUpBusiness(setup: PendingSetup): Promise<string | null> {
  let tenantId: string;
  try {
    ({ id: tenantId } = await api<{ id: string }>('/tenants', { method: 'POST', body: { name: setup.business, slug: slugFor(setup.business) } }));
  } catch (err) {
    if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === 'email_unverified') return null;
    throw err;
  }
  (await cookies()).delete(SETUP_COOKIE);
  await api('/billing/plan', { tenantId, method: 'PUT', body: { plan: setup.plan } });
  for (const id of STARTER_TOOLS) await api(`/modules/${id}`, { tenantId, method: 'PUT', body: { enabled: true } });
  if (setup.website) await api('/billing/website', { tenantId, method: 'PUT', body: { addon: setup.website } });
  if (setup.subscribe) {
    const res = await api<{ url?: string }>('/billing/checkout', { tenantId, method: 'POST' });
    return res.url ?? `/b/${tenantId}/billing?checkout=success`;
  }
  return `/b/${tenantId}?welcome=1`;
}

/** The signup form: an account (unless signed in), the business, its plan, and trial or subscribe. */
export async function startBusiness(_: ActionState, form: FormData): Promise<ActionState> {
  const choice = readChoice(form);
  if ('error' in choice) return choice;
  const jar = await cookies();
  const newAccount = !jar.get(TOKEN_COOKIE);
  if (newAccount && String(form.get('password') ?? '') !== String(form.get('confirm') ?? '')) return { error: 'The passwords don’t match' };
  let next: string | null = null;
  const result = await attempt(async () => {
    if (newAccount) {
      const { token } = await api<{ token: string }>('/auth/signup', {
        method: 'POST',
        anonymous: true,
        body: { email: field(form, 'email'), name: field(form, 'name'), password: String(form.get('password') ?? '') },
      });
      jar.set(TOKEN_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_SECONDS });
    }
    next = await setUpBusiness(choice);
    if (!next) {
      await keepPendingSetup(choice);
      next = '/start/confirm';
    }
  });
  if (result?.error) return result;
  redirect(next!);
}

/** After confirming the email: finish what the signup form started. */
export async function finishSetup(_: ActionState): Promise<ActionState> {
  const setup = await readPendingSetup();
  if (!setup) redirect('/start');
  let next: string | null = null;
  const result = await attempt(async () => {
    next = await setUpBusiness(setup);
  });
  if (result?.error) return result;
  if (!next) return { error: 'Your email isn’t confirmed yet. Open the link we sent you, then try again.' };
  redirect(next);
}

export async function forgetSetup() {
  (await cookies()).delete(SETUP_COOKIE);
  redirect('/businesses');
}

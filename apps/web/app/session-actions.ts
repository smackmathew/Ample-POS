'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, attempt, TOKEN_COOKIE, type ActionState } from '@/lib/api';

const field = (form: FormData, key: string) => String(form.get(key) ?? '');

async function keepSession(token: string, maxAgeSeconds: number) {
  (await cookies()).set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

/** Built-in accounts keep a 30-day session; signing out ends it on the server too. */
const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** Only same-site paths, so a crafted link can't send people elsewhere after signing in. */
function safeNext(form: FormData): string {
  const next = field(form, 'next');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/businesses';
}

export async function signIn(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const { token } = await api<{ token: string }>('/auth/login', {
      method: 'POST',
      anonymous: true,
      body: { email: field(form, 'email'), password: field(form, 'password') },
    });
    await keepSession(token, SESSION_SECONDS);
  });
  if (result?.error) return result;
  redirect(safeNext(form));
}

export async function signUp(_: ActionState, form: FormData): Promise<ActionState> {
  if (field(form, 'password') !== field(form, 'confirm')) return { error: 'The passwords don’t match' };
  const result = await attempt(async () => {
    const { token } = await api<{ token: string }>('/auth/signup', {
      method: 'POST',
      anonymous: true,
      body: { email: field(form, 'email'), name: field(form, 'name'), password: field(form, 'password') },
    });
    await keepSession(token, SESSION_SECONDS);
  });
  if (result?.error) return result;
  redirect(safeNext(form));
}

export async function forgotPassword(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/auth/password/forgot', { method: 'POST', anonymous: true, body: { email: field(form, 'email') } });
    return { ok: 'If that email has an account, a reset link is on its way. It works for one hour.' };
  });
}

export async function resetPassword(token: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (field(form, 'password') !== field(form, 'confirm')) return { error: 'The passwords don’t match' };
  const result = await attempt(async () => {
    const res = await api<{ token: string }>('/auth/password/reset', {
      method: 'POST',
      anonymous: true,
      body: { token, password: field(form, 'password') },
    });
    await keepSession(res.token, SESSION_SECONDS);
  });
  if (result?.error) return result;
  redirect('/businesses');
}

export async function changePassword(_: ActionState, form: FormData): Promise<ActionState> {
  if (field(form, 'newPassword') !== field(form, 'confirm')) return { error: 'The new passwords don’t match' };
  return attempt(async () => {
    await api('/auth/password', {
      method: 'POST',
      body: { currentPassword: field(form, 'currentPassword'), newPassword: field(form, 'newPassword') },
    });
    return { ok: 'Password changed. Other devices have been signed out.' };
  });
}

export async function resendVerification(): Promise<ActionState> {
  return attempt(async () => {
    const { sent } = await api<{ sent: boolean }>('/auth/email/verify-request', { method: 'POST' });
    return sent ? { ok: 'Sent. Check your inbox (and spam folder) for the link.' } : { ok: 'Your email is already confirmed.' };
  });
}

/** Local development (AUTH_MODE=dev): sign in as any email. */
export async function devSignIn(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const { token } = await api<{ token: string }>('/dev/token', {
      method: 'POST',
      anonymous: true,
      body: { email: form.get('email'), name: form.get('name') || undefined },
    });
    await keepSession(token, 60 * 60 * 12);
  });
  if (result?.error) return result;
  redirect('/businesses');
}

async function endSession(everywhere: boolean) {
  const jar = await cookies();
  if (jar.get(TOKEN_COOKIE)) {
    // Best effort: the cookie goes either way, and demo tokens have no server session.
    await api(everywhere ? '/auth/logout-all' : '/auth/logout', { method: 'POST' }).catch(() => {});
  }
  jar.delete(TOKEN_COOKIE);
  redirect('/login');
}

export async function signOut() {
  await endSession(false);
}

export async function signOutEverywhere() {
  await endSession(true);
}

export async function createBusiness(_: ActionState, form: FormData): Promise<ActionState> {
  let id: string | undefined;
  const result = await attempt(async () => {
    ({ id } = await api<{ id: string }>('/tenants', {
      method: 'POST',
      body: { name: form.get('name'), slug: form.get('slug') },
    }));
  });
  if (result?.error) return result;
  redirect(`/b/${id}`);
}

export async function acceptInvitation(_: ActionState, form: FormData): Promise<ActionState> {
  let tenantId: string | undefined;
  const result = await attempt(async () => {
    ({ tenantId } = await api<{ tenantId: string }>('/invitations/accept', {
      method: 'POST',
      body: { code: String(form.get('code') ?? '').trim() },
    }));
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}`);
}

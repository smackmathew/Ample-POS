'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, attempt, TOKEN_COOKIE, type ActionState } from '@/lib/api';

export async function devSignIn(_: ActionState, form: FormData): Promise<ActionState> {
  const result = await attempt(async () => {
    const { token } = await api<{ token: string }>('/dev/token', {
      method: 'POST',
      anonymous: true,
      body: { email: form.get('email'), name: form.get('name') || undefined },
    });
    (await cookies()).set(TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
  });
  if (result?.error) return result;
  redirect('/businesses');
}

export async function signOut() {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect('/login');
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

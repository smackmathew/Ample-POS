import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const TOKEN_COOKIE = 'pos_token';
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

interface Options {
  tenantId?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the bearer token (for public endpoints). */
  anonymous?: boolean;
}

/** Calls the API from server components and server actions with the session token. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!options.anonymous) {
    const token = (await cookies()).get(TOKEN_COOKIE)?.value;
    if (!token) redirect('/login');
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.tenantId) headers['X-Tenant-Id'] = options.tenantId;

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  if (res.status === 401 && !options.anonymous) redirect('/login');

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(', ') : (data?.message ?? res.statusText);
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export type ActionState = { ok?: string; error?: string; secret?: string; qrSvg?: string } | undefined;

/** Base URL devices use to reach the API (may differ from the server-side API_URL). */
export const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? API_URL;

/** Wraps a server action so API errors become form messages instead of error pages. */
export async function attempt(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: 'Saved' };
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
}

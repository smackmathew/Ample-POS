import { createHmac, timingSafeEqual } from 'node:crypto';
import { ShopifyError } from './client';

/** What Ample POS asks a store for. */
export const SHOPIFY_SCOPES = 'read_products,read_orders,read_locations,read_inventory,write_inventory';

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token expires (they last about an hour). */
  expiresAt: string;
  refreshExpiresAt: string;
  scope: string;
}

/** Shopify's approval page for installing the app on `shop` (offline access by default). */
export function authorizeUrl(input: { shop: string; clientId: string; redirectUri: string; state: string; scopes?: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes ?? SHOPIFY_SCOPES,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${input.shop}/admin/oauth/authorize?${params}`;
}

/**
 * Checks the hmac Shopify adds to the redirect: every other query parameter,
 * sorted by name and joined as k=v&k=v, signed with the app's client secret.
 */
export function verifyCallbackHmac(params: Record<string, string>, clientSecret: string): boolean {
  const given = params.hmac;
  if (!given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const message = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const expected = createHmac('sha256', clientSecret).update(message).digest();
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Exchanges the redirect's code for an expiring offline token (required for new public apps). */
export function exchangeCode(fetchImpl: typeof fetch, input: { shop: string; clientId: string; clientSecret: string; code: string }) {
  return tokenRequest(fetchImpl, input.shop, { client_id: input.clientId, client_secret: input.clientSecret, code: input.code, expiring: '1' });
}

/** Gets a new access token (and a new refresh token, which replaces the old one). */
export function refreshTokens(fetchImpl: typeof fetch, input: { shop: string; clientId: string; clientSecret: string; refreshToken: string }) {
  return tokenRequest(fetchImpl, input.shop, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  });
}

async function tokenRequest(fetchImpl: typeof fetch, shop: string, form: Record<string, string>): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new ShopifyError(`Could not reach Shopify: ${(err as Error).message}`, true);
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    const reason = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new ShopifyError(`the token request was refused (${reason})`, res.status >= 500 || res.status === 429, res.status);
  }
  const now = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now + (body.expires_in ?? 3600) * 1000).toISOString(),
    refreshExpiresAt: new Date(now + (body.refresh_token_expires_in ?? 90 * 86400) * 1000).toISOString(),
    scope: body.scope ?? '',
  };
}

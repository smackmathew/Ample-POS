import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { SHOPIFY_OAUTH_COOKIE } from '@/lib/shopify';

/**
 * Shopify sends the merchant here after they approve the app. The cookie set
 * when they clicked "Connect with Shopify" says which business this is for and
 * carries the nonce the API checks, so a link started by someone else can't
 * attach a store to the wrong business.
 */
export async function GET(request: NextRequest) {
  const jar = await cookies();
  const [tenantId, nonce] = (jar.get(SHOPIFY_OAUTH_COOKIE)?.value ?? '').split('.');
  jar.delete({ name: SHOPIFY_OAUTH_COOKIE, path: '/shopify/callback' });
  const base = new URL('/', request.url);
  if (!tenantId || !nonce) {
    return NextResponse.redirect(new URL('/businesses', base));
  }
  const back = new URL(`/b/${tenantId}/sync`, base);
  try {
    await api('/integrations/shopify/oauth/complete', {
      tenantId,
      method: 'POST',
      body: { params: Object.fromEntries(request.nextUrl.searchParams), nonce },
    });
    back.searchParams.set('connected', '1');
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    back.searchParams.set('error', err.message);
  }
  return NextResponse.redirect(back);
}

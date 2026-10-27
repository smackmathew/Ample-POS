'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';
import type { Sale, SalePayment } from '@/lib/types';

/** Result for calls made from the register screen: data or a message to show. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

export interface CatalogHit {
  variantId: string;
  label: string;
  sku: string | null;
  priceMinor: number;
}

/** Exact barcode/SKU match first, otherwise a name search. */
export async function findProducts(tenantId: string, query: string): Promise<Result<CatalogHit[]>> {
  return call(async () => {
    const q = query.trim();
    if (!q) return [];
    try {
      const v = await api<{ id: string; name: string; sku: string | null; priceMinor: number; product: { name: string } }>(
        `/catalog/lookup?code=${encodeURIComponent(q)}`,
        { tenantId },
      );
      return [{ variantId: v.id, label: v.name === 'Default' ? v.product.name : `${v.product.name} — ${v.name}`, sku: v.sku, priceMinor: v.priceMinor }];
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    const { products } = await api<{ products: { name: string; variants: { id: string; name: string; sku: string | null; priceMinor: number; status: string }[] }[] }>(
      `/catalog/products?search=${encodeURIComponent(q)}&limit=20`,
      { tenantId },
    );
    return products.flatMap((p) =>
      p.variants
        .filter((v) => v.status === 'active')
        .map((v) => ({ variantId: v.id, label: v.name === 'Default' ? p.name : `${p.name} — ${v.name}`, sku: v.sku, priceMinor: v.priceMinor })),
    );
  });
}

export async function createSale(
  tenantId: string,
  input: { id: string; registerSessionId: string; lines: { variantId: string; quantity: number; discountMinor: number }[] },
): Promise<Result<Sale>> {
  return call(() => api<Sale>('/sales', { tenantId, method: 'POST', body: input }));
}

type PaymentResult = { payment: SalePayment; clientSecret: string | null; sale: Sale };

export async function payCash(tenantId: string, saleId: string, paymentId: string, tenderedMinor: number): Promise<Result<PaymentResult>> {
  return call(() => api<PaymentResult>(`/sales/${saleId}/payments`, { tenantId, method: 'POST', body: { id: paymentId, method: 'cash', tenderedMinor } }));
}

export async function startCard(tenantId: string, saleId: string, paymentId: string, amountMinor: number): Promise<Result<PaymentResult>> {
  return call(() => api<PaymentResult>(`/sales/${saleId}/payments`, { tenantId, method: 'POST', body: { id: paymentId, method: 'card', amountMinor } }));
}

export async function cardStep(tenantId: string, saleId: string, paymentId: string, step: 'sync' | 'cancel' | 'approve' | 'decline'): Promise<Result<Sale>> {
  return call(() =>
    step === 'approve' || step === 'decline'
      ? api<Sale>(`/sales/${saleId}/payments/${paymentId}/simulate`, { tenantId, method: 'POST', body: { outcome: step } })
      : api<Sale>(`/sales/${saleId}/payments/${paymentId}/${step}`, { tenantId, method: 'POST' }),
  );
}

export async function voidSale(tenantId: string, saleId: string): Promise<Result<Sale>> {
  return call(() => api<Sale>(`/sales/${saleId}/void`, { tenantId, method: 'POST' }));
}

// Forms -----------------------------------------------------------------------

export async function openRegister(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const float = parseMoney(String(form.get('float') ?? '0') || '0');
  if (float === null) return { error: 'Enter the starting cash as an amount like 100.00' };
  const result = await attempt(async () => {
    await api('/registers/sessions', { tenantId, method: 'POST', body: { locationId: form.get('locationId'), openingFloatMinor: float } });
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/sales/register`);
}

export async function closeRegister(tenantId: string, sessionId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const counted = parseMoney(String(form.get('counted') ?? ''));
  if (counted === null) return { error: 'Enter the cash counted in the drawer, like 245.50' };
  const result = await attempt(async () => {
    await api(`/registers/sessions/${sessionId}/close`, { tenantId, method: 'POST', body: { countedCashMinor: counted } });
  });
  if (result?.error) return result;
  // Show the closing summary (expected vs counted) on the sales page.
  redirect(`/b/${tenantId}/sales?closed=${sessionId}`);
}

export async function refundSale(tenantId: string, saleId: string, refundId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const lines = [...form.entries()]
    .filter(([k]) => k.startsWith('qty:'))
    .map(([k, v]) => ({ saleLineId: k.slice(4), quantity: Number(v) }))
    .filter((l) => Number.isInteger(l.quantity) && l.quantity > 0);
  if (!lines.length) return { error: 'Choose at least one item to refund' };
  return attempt(async () => {
    const current = await api<{ session: { id: string } | null }>('/registers/sessions/current', { tenantId });
    await api(`/sales/${saleId}/refunds`, {
      tenantId,
      method: 'POST',
      body: {
        id: refundId,
        lines,
        restock: form.get('restock') === 'on',
        reason: String(form.get('reason') ?? '').trim() || undefined,
        registerSessionId: current.session?.id,
      },
    });
    revalidatePath(`/b/${tenantId}/sales/${saleId}`);
    return { ok: 'Refund recorded' };
  });
}

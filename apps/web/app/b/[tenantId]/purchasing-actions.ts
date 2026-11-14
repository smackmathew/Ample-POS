'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, attempt, type ActionState } from '@/lib/api';
import type { LowStockItem, PurchaseOrder } from '@/lib/types';
import type { Result } from './sales-actions';

async function call<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

// Suppliers -------------------------------------------------------------------

export async function addSupplier(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/suppliers', {
      tenantId,
      method: 'POST',
      body: { name: text(form, 'name'), contactName: text(form, 'contactName'), email: text(form, 'email'), phone: text(form, 'phone'), notes: text(form, 'notes') },
    });
    revalidatePath(`/b/${tenantId}/purchasing/suppliers`);
    return { ok: 'Supplier added' };
  });
}

export async function updateSupplier(tenantId: string, supplierId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/suppliers/${supplierId}`, {
      tenantId,
      method: 'PATCH',
      body: { name: text(form, 'name'), contactName: text(form, 'contactName'), email: text(form, 'email'), phone: text(form, 'phone'), notes: text(form, 'notes') },
    });
    revalidatePath(`/b/${tenantId}/purchasing/suppliers`);
    return { ok: 'Saved' };
  });
}

export async function archiveSupplier(tenantId: string, supplierId: string, archived: boolean): Promise<void> {
  await api(`/suppliers/${supplierId}`, { tenantId, method: 'PATCH', body: { archived } });
  revalidatePath(`/b/${tenantId}/purchasing/suppliers`);
}

// Orders ----------------------------------------------------------------------

export async function newOrder(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id = '';
  const result = await attempt(async () => {
    id = (await api<{ id: string }>('/purchase-orders', { tenantId, method: 'POST', body: { supplierId: form.get('supplierId'), locationId: form.get('locationId'), lines: [] } })).id;
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/purchasing/${id}`);
}

export interface OrderItem {
  variantId: string;
  description: string;
  sku: string | null;
  costMinor: number | null;
}

/** Tracked, active items matching a search, with their current cost. */
export async function searchItems(tenantId: string, query: string): Promise<Result<OrderItem[]>> {
  return call(async () => {
    const q = query.trim();
    if (!q) return [];
    const { products } = await api<{
      products: { name: string; status: string; variants: { id: string; name: string; sku: string | null; costMinor: number | null; status: string; trackInventory: boolean }[] }[];
    }>(`/catalog/products?search=${encodeURIComponent(q)}&limit=20`, { tenantId });
    return products
      .filter((p) => p.status === 'active')
      .flatMap((p) =>
        p.variants
          .filter((v) => v.status === 'active' && v.trackInventory)
          .map((v) => ({ variantId: v.id, description: v.name === 'Default' ? p.name : `${p.name} — ${v.name}`, sku: v.sku, costMinor: v.costMinor })),
      );
  });
}

export async function lowStock(tenantId: string, locationId: string, atOrBelow: number): Promise<Result<LowStockItem[]>> {
  return call(() => api<LowStockItem[]>(`/purchase-orders/low-stock?locationId=${locationId}&atOrBelow=${atOrBelow}`, { tenantId }));
}

export async function saveDraft(
  tenantId: string,
  orderId: string,
  input: { supplierId: string; locationId: string; note: string; expectedOn: string; lines: { variantId: string; quantity: number; unitCostMinor: number }[] },
): Promise<Result<PurchaseOrder>> {
  return call(async () => {
    const order = await api<PurchaseOrder>(`/purchase-orders/${orderId}`, {
      tenantId,
      method: 'PUT',
      body: { ...input, note: input.note || undefined, expectedOn: input.expectedOn || null },
    });
    revalidatePath(`/b/${tenantId}/purchasing/${orderId}`);
    return order;
  });
}

export async function placeOrder(tenantId: string, orderId: string, email: boolean, message: string): Promise<Result<PurchaseOrder & { emailedTo: string | null }>> {
  return call(async () => {
    const order = await api<PurchaseOrder & { emailedTo: string | null }>(`/purchase-orders/${orderId}/order`, {
      tenantId,
      method: 'POST',
      body: { email, message: message || undefined },
    });
    revalidatePath(`/b/${tenantId}/purchasing/${orderId}`);
    return order;
  });
}

export async function receiveOrder(tenantId: string, orderId: string, receiptId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const lines = [...form.entries()]
    .filter(([k]) => k.startsWith('qty:'))
    .map(([k, v]) => ({ lineId: k.slice(4), quantity: Number(String(v).trim() || '0') }));
  if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 0)) return { error: 'Quantities must be whole numbers' };
  if (!lines.some((l) => l.quantity > 0)) return { error: 'Enter how many of at least one item arrived' };
  return attempt(async () => {
    await api(`/purchase-orders/${orderId}/receive`, {
      tenantId,
      method: 'POST',
      body: { id: receiptId, lines, updateCosts: form.get('updateCosts') === 'on', note: text(form, 'note') || undefined },
    });
    revalidatePath(`/b/${tenantId}/purchasing/${orderId}`);
    return { ok: `Received ${lines.reduce((n, l) => n + l.quantity, 0)} units into stock` };
  });
}

export async function finishOrder(tenantId: string, orderId: string, action: 'close' | 'cancel'): Promise<Result<PurchaseOrder>> {
  return call(async () => {
    const order = await api<PurchaseOrder>(`/purchase-orders/${orderId}/${action}`, { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}/purchasing/${orderId}`);
    return order;
  });
}

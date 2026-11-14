'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, attempt, type ActionState } from '@/lib/api';
import type { CustomerSummary, Sale } from '@/lib/types';
import type { Result } from './sales-actions';

/** What the register needs to show a customer. */
export type CustomerPick = Pick<CustomerSummary, 'id' | 'name' | 'email' | 'phone'>;

const fields = (form: FormData) => ({
  name: String(form.get('name') ?? ''),
  email: String(form.get('email') ?? ''),
  phone: String(form.get('phone') ?? ''),
});

export async function findCustomers(tenantId: string, query: string): Promise<Result<CustomerPick[]>> {
  try {
    const found = await api<CustomerSummary[]>(`/customers?limit=8&search=${encodeURIComponent(query.trim())}`, { tenantId });
    return { ok: true, data: found.map(({ id, name, email, phone }) => ({ id, name, email, phone })) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Adds a customer from the register. When the email or phone already belongs
 * to someone, that customer is picked instead, with a note saying so.
 */
export async function quickAddCustomer(tenantId: string, input: { name: string; email: string; phone: string }): Promise<Result<{ customer: CustomerPick; note?: string }>> {
  try {
    const c = await api<CustomerPick>('/customers', { tenantId, method: 'POST', body: input });
    return { ok: true, data: { customer: { id: c.id, name: c.name, email: c.email, phone: c.phone } } };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const existing = (err.body as { code?: string; customer?: { id: string } } | null)?.customer;
    if (err.status === 409 && existing) {
      const c = await api<CustomerPick>(`/customers/${existing.id}`, { tenantId });
      return { ok: true, data: { customer: { id: c.id, name: c.name, email: c.email, phone: c.phone }, note: `${err.message}, so they’re on this sale.` } };
    }
    return { ok: false, error: err.message };
  }
}

export async function setSaleCustomer(tenantId: string, saleId: string, customerId: string | null): Promise<Result<Sale>> {
  try {
    const sale = await api<Sale>(`/sales/${saleId}/customer`, { tenantId, method: 'POST', body: { customerId } });
    revalidatePath(`/b/${tenantId}/sales/${saleId}`);
    return { ok: true, data: sale };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Sends the receipt to the customer on the sale. */
export async function emailReceiptToCustomer(tenantId: string, saleId: string): Promise<Result<true>> {
  try {
    await api(`/sales/${saleId}/receipt/email`, { tenantId, method: 'POST', body: {} });
    return { ok: true, data: true };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

// Forms -----------------------------------------------------------------------

export async function addCustomer(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id = '';
  const result = await attempt(async () => {
    id = (await api<{ id: string }>('/customers', { tenantId, method: 'POST', body: { ...fields(form), note: String(form.get('note') ?? '') } })).id;
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/customers/${id}`);
}

export async function updateCustomer(tenantId: string, customerId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/customers/${customerId}`, { tenantId, method: 'PATCH', body: { ...fields(form), note: String(form.get('note') ?? '') } });
    revalidatePath(`/b/${tenantId}/customers/${customerId}`);
    return { ok: 'Saved' };
  });
}

export async function deleteCustomer(tenantId: string, customerId: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (form.get('confirm') !== 'on') return { error: 'Tick the box to confirm' };
  const result = await attempt(async () => {
    await api(`/customers/${customerId}`, { tenantId, method: 'DELETE' });
  });
  if (result?.error) return result;
  revalidatePath(`/b/${tenantId}/customers`);
  redirect(`/b/${tenantId}/customers?deleted=1`);
}

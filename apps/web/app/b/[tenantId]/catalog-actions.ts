'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';

const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

const barcodes = (raw: string | undefined) =>
  (raw ?? '')
    .split(/[\s,]+/)
    .map((b) => b.trim())
    .filter(Boolean);

function money(form: FormData, key: string, label: string, required: boolean): number | null | undefined {
  const raw = str(form, key);
  if (raw === undefined) {
    if (required) throw new FormError(`${label} is required`);
    return null;
  }
  const value = parseMoney(raw);
  if (value === null) throw new FormError(`${label} must be an amount like 12.50`);
  return value;
}

class FormError extends Error {}

async function guard(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return await attempt(fn);
  } catch (err) {
    if (err instanceof FormError) return { error: err.message };
    throw err;
  }
}

/** The new-product form has numbered variant rows; blank rows are ignored. */
export async function createProduct(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id: string | undefined;
  const result = await guard(async () => {
    const variants = [];
    for (let i = 0; i < 5; i++) {
      const name = str(form, `v${i}.name`);
      const price = str(form, `v${i}.price`);
      if (i > 0 && !name && !price) continue;
      variants.push({
        name: name ?? 'Default',
        sku: str(form, `v${i}.sku`) ?? null,
        priceMinor: money(form, `v${i}.price`, `Price for ${name ?? 'variant'}`, true),
        barcodes: barcodes(str(form, `v${i}.barcodes`)),
        trackInventory: form.get('trackInventory') !== 'off',
      });
    }
    ({ id } = await api<{ id: string }>('/catalog/products', {
      tenantId,
      method: 'POST',
      body: { name: str(form, 'name'), category: str(form, 'category') ?? null, variants },
    }));
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/catalog/${id}`);
}

export async function updateProduct(tenantId: string, productId: string, version: number, _: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    await api(`/catalog/products/${productId}`, {
      tenantId,
      method: 'PATCH',
      body: {
        version,
        name: str(form, 'name'),
        category: str(form, 'category') ?? null,
        description: str(form, 'description') ?? null,
        status: str(form, 'status'),
      },
    });
    revalidatePath(`/b/${tenantId}/catalog`, 'layout');
  });
}

export async function updateVariant(tenantId: string, variantId: string, version: number, _: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    await api(`/catalog/variants/${variantId}`, {
      tenantId,
      method: 'PATCH',
      body: {
        version,
        name: str(form, 'name'),
        sku: str(form, 'sku') ?? null,
        priceMinor: money(form, 'price', 'Price', true),
        costMinor: money(form, 'cost', 'Cost', false),
        status: str(form, 'status'),
        barcodes: barcodes(str(form, 'barcodes')),
      },
    });
    revalidatePath(`/b/${tenantId}/catalog`, 'layout');
  });
}

export async function addVariant(tenantId: string, productId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    await api(`/catalog/products/${productId}/variants`, {
      tenantId,
      method: 'POST',
      body: {
        name: str(form, 'name'),
        sku: str(form, 'sku') ?? null,
        priceMinor: money(form, 'price', 'Price', true),
        barcodes: barcodes(str(form, 'barcodes')),
      },
    });
    revalidatePath(`/b/${tenantId}/catalog`, 'layout');
    return { ok: 'Variant added' };
  });
}

// Inventory ------------------------------------------------------------------

type StockOp = 'receive' | 'adjust' | 'transfer';

export async function stockOperation(tenantId: string, op: StockOp, _: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const variantId = str(form, 'variantId');
    const qty = Number(str(form, 'quantity'));
    if (!Number.isInteger(qty) || qty === 0) throw new FormError('Enter a whole-number quantity');
    // One key per form submission, so a double-submit is applied once.
    const idempotencyKey = str(form, 'idempotencyKey') ?? randomUUID();
    const note = str(form, 'note');
    if (op === 'receive') {
      if (qty < 0) throw new FormError('Received quantity must be positive');
      await api('/inventory/receipts', { tenantId, method: 'POST', body: { locationId: str(form, 'locationId'), lines: [{ variantId, quantity: qty }], note, idempotencyKey } });
    } else if (op === 'adjust') {
      await api('/inventory/adjustments', { tenantId, method: 'POST', body: { locationId: str(form, 'locationId'), lines: [{ variantId, quantityDelta: qty }], note, idempotencyKey } });
    } else {
      if (qty < 0) throw new FormError('Transfer quantity must be positive');
      await api('/inventory/transfers', {
        tenantId,
        method: 'POST',
        body: { fromLocationId: str(form, 'locationId'), toLocationId: str(form, 'toLocationId'), lines: [{ variantId, quantity: qty }], note, idempotencyKey },
      });
    }
    revalidatePath(`/b/${tenantId}/inventory`);
    return { ok: 'Recorded' };
  });
}

export async function startCount(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id: string | undefined;
  const result = await guard(async () => {
    ({ id } = await api<{ id: string }>('/inventory/counts', {
      tenantId,
      method: 'POST',
      body: { locationId: str(form, 'locationId'), name: str(form, 'name') },
    }));
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/inventory/counts/${id}`);
}

/** Looks up a scanned barcode or SKU and records it as a count entry. */
export async function countScan(tenantId: string, countId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const code = str(form, 'code');
    if (!code) throw new FormError('Scan or type a barcode or SKU');
    const qty = Number(str(form, 'quantity') ?? '1');
    if (!Number.isInteger(qty) || qty < 1) throw new FormError('Quantity must be at least 1');
    const variant = await api<{ id: string; name: string; product: { name: string } }>(`/catalog/lookup?code=${encodeURIComponent(code)}`, { tenantId });
    await api(`/inventory/counts/${countId}/entries`, {
      tenantId,
      method: 'POST',
      body: { entries: [{ id: randomUUID(), variantId: variant.id, quantity: qty }] },
    });
    revalidatePath(`/b/${tenantId}/inventory/counts/${countId}`);
    const label = variant.name === 'Default' ? variant.product.name : `${variant.product.name} — ${variant.name}`;
    return { ok: `Counted ${qty} × ${label}` };
  });
}

export async function voidCountEntry(tenantId: string, countId: string, entryId: string) {
  await api(`/inventory/counts/${countId}/entries/${entryId}/void`, { tenantId, method: 'POST' });
  revalidatePath(`/b/${tenantId}/inventory/counts/${countId}`);
}

export async function countTransition(tenantId: string, countId: string, step: 'submit' | 'reopen' | 'approve' | 'cancel', _: ActionState): Promise<ActionState> {
  return guard(async () => {
    await api(`/inventory/counts/${countId}/${step}`, { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}/inventory/counts/${countId}`);
  });
}

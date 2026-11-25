'use server';

import { revalidatePath } from 'next/cache';
import { api, attempt, type ActionState } from '@/lib/api';

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};
const page = (tenantId: string) => `/b/${tenantId}/devices`;

export async function addPrinter(tenantId: string, kind: 'receipt' | 'tag', _: ActionState, form: FormData): Promise<ActionState> {
  const port = text(form, 'port');
  return attempt(async () => {
    await api('/printers', {
      tenantId,
      method: 'POST',
      body: {
        kind,
        locationId: text(form, 'locationId'),
        name: text(form, 'name'),
        connection: text(form, 'connection'),
        address: text(form, 'address'),
        port: port ? Number(port) : null,
        language: text(form, 'language'),
        paper: text(form, 'paper'),
        registerId: text(form, 'registerId'),
      },
    });
    revalidatePath(page(tenantId));
    return { ok: 'Printer added' };
  });
}

export async function assignPrinter(tenantId: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/printers/${id}`, { tenantId, method: 'PATCH', body: { registerId: text(form, 'registerId') } });
    revalidatePath(page(tenantId));
    return { ok: 'Saved' };
  });
}

export async function removePrinter(tenantId: string, id: string) {
  await api(`/printers/${id}`, { tenantId, method: 'DELETE' });
  revalidatePath(page(tenantId));
}

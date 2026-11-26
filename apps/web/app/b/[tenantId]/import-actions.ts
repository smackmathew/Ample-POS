'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, attempt, type ActionState } from '@/lib/api';

const MAX_BYTES = 10 * 1024 * 1024;

/** Reads the uploaded file and opens its preview. Nothing is imported yet. */
export async function startImport(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file' };
  if (file.size > MAX_BYTES) return { error: 'The file is over 10 MB; split it into smaller files' };
  const excel = /\.xlsx$/i.test(file.name);
  if (/\.xls$/i.test(file.name)) return { error: 'That’s an older Excel file (.xls). Open it in Excel and save it as .xlsx, or as CSV.' };
  if (!excel && !/\.(csv|txt|tsv)$/i.test(file.name)) return { error: 'Choose an Excel (.xlsx) or CSV file.' };
  let id: string | undefined;
  const result = await attempt(async () => {
    const preview = await api<{ batch: { id: string } }>('/imports', {
      tenantId,
      method: 'POST',
      body: {
        kind: form.get('kind'),
        source: form.get('source'),
        fileName: file.name,
        ...(excel ? { xlsx: Buffer.from(await file.arrayBuffer()).toString('base64') } : { csv: await file.text() }),
        locationId: (form.get('locationId') as string) || null,
      },
    });
    id = preview.batch.id;
  });
  if (result?.error) return result;
  redirect(`/b/${tenantId}/import/${id}`);
}

export async function saveMapping(tenantId: string, batchId: string, fields: string[], _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const mapping = Object.fromEntries(fields.map((f) => [f, (form.get(`map_${f}`) as string) || null]));
    const location = form.get('locationId');
    await api(`/imports/${batchId}/mapping`, {
      tenantId,
      method: 'PUT',
      body: { mapping, ...(location !== null ? { locationId: (location as string) || null } : {}) },
    });
    revalidatePath(`/b/${tenantId}/import/${batchId}`);
    return { ok: 'Preview updated' };
  });
}

export async function commitImport(tenantId: string, batchId: string, _: ActionState): Promise<ActionState> {
  const result = await attempt(async () => {
    await api(`/imports/${batchId}/commit`, { tenantId, method: 'POST' });
  });
  if (result?.error) return result;
  revalidatePath(`/b/${tenantId}/import`);
  redirect(`/b/${tenantId}/import?done=${batchId}`);
}

export async function undoImport(tenantId: string, batchId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const res = await api<{ kept: number }>(`/imports/${batchId}/undo`, { tenantId, method: 'POST' });
    revalidatePath(`/b/${tenantId}/import`);
    return { ok: res.kept ? `Undone. ${res.kept} customers who have bought something since were kept.` : 'Undone' };
  });
}

/** The owner accepts the reconciliation report as it stands. */
export async function signOffMigration(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/migration/sign-off', { tenantId, method: 'POST', body: { note: String(form.get('note') ?? '') } });
    revalidatePath(`/b/${tenantId}/import/reconciliation`);
    return { ok: 'Signed off. The report is kept with your name and today’s date.' };
  });
}

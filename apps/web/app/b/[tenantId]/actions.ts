'use server';

import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';
import { api, attempt, PUBLIC_API_URL, type ActionState } from '@/lib/api';
import { parsePercentToBps } from '@/lib/pricing';

const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export async function toggleModule(tenantId: string, moduleId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api(`/modules/${moduleId}`, { tenantId, method: 'PUT', body: { enabled } });
    revalidatePath(`/b/${tenantId}`, 'layout');
  });
}

/** The address fields of a form, or null when they were left blank. */
function addressFrom(form: FormData) {
  const field = (k: string) => String(form.get(k) ?? '').trim();
  const address = { line1: field('line1'), line2: field('line2'), city: field('city'), state: field('state'), postalCode: field('postalCode'), country: field('country') || 'US' };
  return address.line1 || address.city || address.postalCode ? address : null;
}

export async function createLocation(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const taxRateBps = parsePercentToBps(str(form, 'taxRate') ?? '0');
  if (taxRateBps === null) return { error: 'Sales tax must be a percentage like 8.25' };
  return attempt(async () => {
    await api('/locations', {
      tenantId,
      method: 'POST',
      body: { name: str(form, 'name'), kind: str(form, 'kind'), timezone: str(form, 'timezone'), taxRateBps, address: addressFrom(form) },
    });
    revalidatePath(`/b/${tenantId}/locations`);
    return { ok: 'Location added' };
  });
}

export async function setLocationAddress(tenantId: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/locations/${id}`, { tenantId, method: 'PATCH', body: { address: addressFrom(form) } });
    revalidatePath(`/b/${tenantId}/locations`);
    return { ok: 'Address saved' };
  });
}

export async function setLocationArchived(tenantId: string, id: string, archived: boolean) {
  await api(`/locations/${id}`, { tenantId, method: 'PATCH', body: { archived } });
  revalidatePath(`/b/${tenantId}/locations`);
}

export async function registerDevice(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { credential } = await api<{ credential: string }>('/devices', {
      tenantId,
      method: 'POST',
      body: { locationId: str(form, 'locationId'), name: str(form, 'name'), kind: str(form, 'kind') },
    });
    revalidatePath(`/b/${tenantId}/devices`);
    // Scanned by the mobile app to pair: where the API is, which business, and the credential.
    const pairing = JSON.stringify({ v: 1, api: PUBLIC_API_URL, tenantId, credential });
    const qrSvg = await QRCode.toString(pairing, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret: credential, qrSvg };
  });
}

export async function revokeDevice(tenantId: string, id: string) {
  await api(`/devices/${id}/revoke`, { tenantId, method: 'POST' });
  revalidatePath(`/b/${tenantId}/devices`);
}

export async function inviteMember(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { code } = await api<{ code: string }>('/invitations', {
      tenantId,
      method: 'POST',
      body: { roleId: str(form, 'roleId'), email: str(form, 'email') },
    });
    return { secret: code };
  });
}

export async function updateMember(tenantId: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/members/${id}`, {
      tenantId,
      method: 'PATCH',
      body: { roleId: str(form, 'roleId'), status: str(form, 'status') },
    });
    revalidatePath(`/b/${tenantId}/team`);
  });
}

export async function saveRole(tenantId: string, roleId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const body = { name: str(form, 'name'), permissions: form.getAll('permissions').map(String) };
    await api(roleId ? `/roles/${roleId}` : '/roles', { tenantId, method: roleId ? 'PATCH' : 'POST', body });
    revalidatePath(`/b/${tenantId}/roles`);
    return { ok: roleId ? 'Role updated' : 'Role created' };
  });
}

/**
 * What the admin hub encodes in the QR code shown when a device is registered.
 * Version 1: { v: 1, api, tenantId, credential } where credential is "<deviceId>.<secret>".
 */
export interface PairingPayload {
  api: string;
  tenantId: string;
  credential: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns null when the scanned text is not an Ample POS pairing code. */
export function parsePairingCode(text: string): PairingPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { v, api, tenantId, credential } = data as Record<string, unknown>;
  if (v !== 1 || typeof api !== 'string' || typeof tenantId !== 'string' || typeof credential !== 'string') return null;
  if (!/^https?:\/\/[^\s]+$/.test(api) || !UUID.test(tenantId)) return null;
  const [deviceId, secret] = credential.split('.', 2);
  if (!deviceId || !UUID.test(deviceId) || !secret) return null;
  return { api, tenantId, credential };
}

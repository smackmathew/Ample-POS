import { createHash, timingSafeEqual } from 'node:crypto';
import { schema, type Transaction } from '@pos/db';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DeviceIdentity } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Checks a "<deviceId>.<secret>" credential against the selected business's
 * active devices (RLS already limits the lookup to that business) and records
 * when the device was last seen. Returns null if it is unknown or revoked.
 */
export async function verifyDeviceCredential(tx: Transaction, credential: string): Promise<DeviceIdentity | null> {
  const dot = credential.indexOf('.');
  const id = credential.slice(0, dot);
  const secret = credential.slice(dot + 1);
  if (dot < 0 || !UUID.test(id) || !secret) return null;

  const [device] = await tx
    .select({ id: schema.devices.id, locationId: schema.devices.locationId, kind: schema.devices.kind, secretHash: schema.devices.secretHash })
    .from(schema.devices)
    .where(and(eq(schema.devices.id, id), eq(schema.devices.status, 'active')));
  if (!device) return null;
  const expected = Buffer.from(device.secretHash, 'hex');
  const actual = Buffer.from(hashDeviceSecret(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  // At most one write a minute per device.
  await tx
    .update(schema.devices)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(schema.devices.id, id),
        or(isNull(schema.devices.lastSeenAt), lt(schema.devices.lastSeenAt, sql`now() - interval '1 minute'`)),
      ),
    );
  return { id: device.id, locationId: device.locationId, kind: device.kind };
}

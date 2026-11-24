import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './database';
import type { ApiKeyIdentity } from './request-context';

/**
 * API keys look like `ak_<key id, 32 hex>_<secret>`. Only a hash of the secret
 * is stored; the full key is shown once, when it's created.
 */
const KEY = /^ak_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export function isApiKey(token: string): boolean {
  return token.startsWith('ak_');
}

export function hashApiSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newApiKey(): { id: string; key: string; hint: string; secretHash: string } {
  const hex = randomBytes(16).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
  const secret = randomBytes(32).toString('base64url');
  const key = `ak_${id.replaceAll('-', '')}_${secret}`;
  return { id, key, hint: `${key.slice(0, 11)}…${key.slice(-4)}`, secretHash: hashApiSecret(secret) };
}

/** The key's identity and its creator, or null when it's malformed, unknown, revoked or wrong. */
export async function verifyApiKey(db: Db, token: string): Promise<(ApiKeyIdentity & { userId: string }) | null> {
  const match = KEY.exec(token);
  if (!match) return null;
  const hex = match[1]!;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const [row] = await db.pool.execute<{ tenant_id: string; user_id: string; name: string; permissions: string[]; read_only: boolean }>(
    sql`select * from app_verify_api_key(${id}::uuid, ${hashApiSecret(match[2]!)})`,
  );
  if (!row) return null;
  return { id, tenantId: row.tenant_id, userId: row.user_id, name: row.name, permissions: row.permissions, readOnly: row.read_only };
}

/**
 * What a request made with the key may do: the key's permissions, but never
 * more than its creator currently holds.
 */
export function effectivePermissions(key: readonly string[], creator: readonly string[]): string[] {
  if (key.includes('*')) return [...creator];
  if (creator.includes('*')) return [...key];
  return key.filter((p) => creator.includes(p));
}

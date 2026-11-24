import { randomBytes } from 'node:crypto';
import type { SecretBox } from '../core/secrets';

/** Signing secrets start with whsec_ so they're easy to recognize. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** Sealed with SECRETS_KEY when it's set; otherwise stored as is (local development). */
export function sealWebhookSecret(box: SecretBox | null, secret: string): string {
  return box ? `sealed:${box.seal(secret)}` : `plain:${secret}`;
}

export function openWebhookSecret(box: SecretBox | null, stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (stored.startsWith('sealed:') && box) return box.open<string>(stored.slice(7));
  throw new Error('Webhook secret can’t be read: SECRETS_KEY is missing or changed');
}

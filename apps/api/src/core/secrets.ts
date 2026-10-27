import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for credentials stored in the database (e.g. a store's access
 * token). The key comes from SECRETS_KEY (32 bytes, base64) and never touches
 * the database, so a database dump alone does not expose third-party access.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognized secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')) as T;
  }
}

export const SECRET_BOX = Symbol('SECRET_BOX');

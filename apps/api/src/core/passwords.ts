import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt with N=2^15, r=8, p=1: about 32 MiB and ~100 ms per hash. Parameters
// are stored with each hash, so they can be raised later without a migration.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...opts, maxmem: 128 * opts.N * opts.r * 2 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Spent on unknown emails so a sign-in takes as long whether or not the account exists. */
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Length is what matters (NIST 800-63B); plus a few obviously bad choices. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  const lower = password.toLowerCase();
  if (lower === email.toLowerCase() || lower === email.split('@')[0]!.toLowerCase()) return 'Don’t use your email as your password';
  if (/^(.)\1+$/.test(password) || ['password123', '1234567890', 'qwertyuiop', '0123456789'].includes(lower)) {
    return 'That password is too easy to guess';
  }
  return null;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, matchTotp, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri } from './totp';

// RFC 6238 appendix B: SHA1 seed "12345678901234567890", 8 digits.
const SEED = Buffer.from('12345678901234567890');

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) expect(hotp(SEED, Math.floor(seconds / 30), 8)).toBe(code);
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it('accepts the current code and one step of drift, nothing further', () => {
    const secret = base32Encode(SEED);
    const now = 1_111_111_111_000;
    const step = Math.floor(now / 30_000);
    const code = (s: number) => hotp(SEED, s);
    expect(matchTotp(secret, code(step), now)).toBe(step);
    expect(matchTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, code(step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, code(step - 2), now)).toBeNull();
    expect(matchTotp(secret, `${code(step).slice(0, 3)} ${code(step).slice(3)}`, now)).toBe(step);
    expect(matchTotp(secret, '12345', now)).toBeNull();
  });

  it('builds the otpauth link and readable recovery codes', () => {
    expect(otpauthUri('ABC', 'pat@example.com')).toBe(
      'otpauth://totp/Ample%20POS%3Apat%40example.com?secret=ABC&issuer=Ample%20POS&algorithm=SHA1&digits=6&period=30',
    );
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(normalizeRecoveryCode(' K7QP-2MZX-9FWD ')).toBe('k7qp2mzx9fwd');
  });
});

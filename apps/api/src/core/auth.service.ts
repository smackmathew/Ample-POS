import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from './config';
import { Db } from './database';
import type { AuthUser } from './request-context';

const DEV_ISSUER = 'pos-hub-dev';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sessions last 30 days from sign-in; signing out or a password change ends them sooner. */
export const SESSION_DAYS = 30;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** "<row id>.<secret>": the id finds the row, the secret (stored only as a hash) proves it. */
export function newToken(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, secretHash: sha256(secret) };
}

export function splitToken(token: string): { id: string; secret: string } | null {
  const dot = token.indexOf('.');
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  return dot > 0 && UUID.test(id) && secret.length >= 32 ? { id, secret } : null;
}

/**
 * Turns a bearer token into a user. Three modes:
 * - password: Ample POS's own accounts; the token is a server-side session.
 * - dev: local development; anyone can mint a token for any email.
 * - jwks: tokens from an external identity provider.
 */
@Injectable()
export class AuthService {
  private readonly devKey?: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {
    if (config.AUTH_MODE === 'dev') this.devKey = new TextEncoder().encode(config.AUTH_DEV_SECRET);
    if (config.AUTH_MODE === 'jwks') this.jwks = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL!));
  }

  get mode(): AppConfig['AUTH_MODE'] {
    return this.config.AUTH_MODE;
  }

  async authenticate(token: string): Promise<AuthUser> {
    if (this.config.AUTH_MODE === 'password') return this.fromSession(token);
    const identity = await this.verifyJwt(token);
    const [row] = await this.db.pool.execute<{ id: string }>(
      sql`select app_upsert_user(${identity.subject}, ${identity.email}, ${identity.name}) as id`,
    );
    return { userId: row!.id, subject: identity.subject, sessionId: null };
  }

  private async fromSession(token: string): Promise<AuthUser> {
    const parts = splitToken(token);
    if (parts) {
      const [row] = await this.db.pool.execute<{ user_id: string | null }>(
        sql`select app_session_user(${parts.id}::uuid, ${sha256(parts.secret)}) as user_id`,
      );
      if (row?.user_id) return { userId: row.user_id, subject: `local|${row.user_id}`, sessionId: parts.id };
    }
    throw new UnauthorizedException('Your session has ended. Sign in again.');
  }

  private async verifyJwt(token: string) {
    try {
      const { payload } = this.devKey
        ? await jwtVerify(token, this.devKey, { issuer: DEV_ISSUER, algorithms: ['HS256'] })
        : await jwtVerify(token, this.jwks!, { issuer: this.config.AUTH_ISSUER, audience: this.config.AUTH_AUDIENCE });
      if (!payload.sub) throw new Error('missing sub');
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Local development only: mint a token for an email address. */
  async issueDevToken(email: string, name: string | null): Promise<string> {
    if (!this.devKey) throw new Error('Dev tokens are only available when AUTH_MODE=dev');
    return new SignJWT({ email, name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(`dev|${email.toLowerCase()}`)
      .setIssuer(DEV_ISSUER)
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(this.devKey);
  }
}

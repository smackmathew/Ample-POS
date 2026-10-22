import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from './config';

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  name: string | null;
}

const DEV_ISSUER = 'pos-hub-dev';

@Injectable()
export class AuthService {
  private readonly devKey?: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.AUTH_MODE === 'dev') {
      this.devKey = new TextEncoder().encode(config.AUTH_DEV_SECRET);
    } else {
      this.jwks = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL!));
    }
  }

  get devMode(): boolean {
    return this.config.AUTH_MODE === 'dev';
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = this.devKey
        ? await jwtVerify(token, this.devKey, { issuer: DEV_ISSUER, algorithms: ['HS256'] })
        : await jwtVerify(token, this.jwks!, {
            issuer: this.config.AUTH_ISSUER,
            audience: this.config.AUTH_AUDIENCE,
          });
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

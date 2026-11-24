import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isApiKey, verifyApiKey } from './api-keys';
import { AuthService } from './auth.service';
import { Db } from './database';
import { PUBLIC_KEY } from './decorators';
import type { ApiKeyIdentity, AuthUser } from './request-context';

export type AuthedRequest = Request & { auth?: AuthUser; apiKey?: ApiKeyIdentity };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    // Another app using an API key: it acts for the person who created the key.
    if (isApiKey(token)) {
      const key = await verifyApiKey(this.db, token);
      if (!key) throw new UnauthorizedException('This API key is not recognized or has been revoked');
      const { userId, ...identity } = key;
      req.auth = { userId, subject: `api-key:${key.id}`, sessionId: null };
      req.apiKey = identity;
      return true;
    }

    req.auth = await this.auth.authenticate(token);
    return true;
  }
}

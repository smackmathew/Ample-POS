import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { Db } from './database';
import { PUBLIC_KEY } from './decorators';
import type { AuthUser } from './request-context';

export type AuthedRequest = Request & { auth?: AuthUser };

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

    const identity = await this.auth.verify(token);
    const [row] = await this.db.pool.execute<{ id: string }>(
      sql`select app_upsert_user(${identity.subject}, ${identity.email}, ${identity.name}) as id`,
    );
    req.auth = { userId: row!.id, subject: identity.subject };
    return true;
  }
}

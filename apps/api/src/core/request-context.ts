import { AsyncLocalStorage } from 'node:async_hooks';
import { InternalServerErrorException } from '@nestjs/common';
import type { Transaction } from '@pos/db';

export interface AuthUser {
  userId: string;
  subject: string;
}

export interface TenantMembership {
  tenantId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  permissions: string[];
}

export interface RequestContext {
  user: AuthUser;
  tx: Transaction;
  /** Null on routes marked @NoTenant(). */
  tenant: TenantMembership | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new InternalServerErrorException('No request context');
  return ctx;
}

/** The current business membership; only valid on tenant-scoped routes. */
export function currentTenant(): TenantMembership {
  const tenant = currentContext().tenant;
  if (!tenant) throw new InternalServerErrorException('Route is not tenant-scoped');
  return tenant;
}

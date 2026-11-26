import { AsyncLocalStorage } from 'node:async_hooks';
import { InternalServerErrorException } from '@nestjs/common';
import type { Transaction } from '@pos/db';

export interface AuthUser {
  userId: string;
  subject: string;
  /** The sign-in session behind the request (built-in accounts only). */
  sessionId: string | null;
}

export interface TenantMembership {
  tenantId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  permissions: string[];
  /** Set when Ample POS staff are viewing the business read-only (see the support view). */
  supportSessionId?: string;
}

export interface DeviceIdentity {
  id: string;
  locationId: string;
  kind: 'register' | 'handheld' | 'kiosk';
}

/** Set when the request was made with an API key (see api-keys). */
export interface ApiKeyIdentity {
  id: string;
  tenantId: string;
  name: string;
  /** What the key was given; the request gets these narrowed to the creator's own permissions. */
  permissions: string[];
  readOnly: boolean;
}

export interface RequestContext {
  /** Null only for system work such as payment webhooks. */
  user: AuthUser | null;
  tx: Transaction;
  /** Null on routes marked @NoTenant(). */
  tenant: TenantMembership | null;
  /** Set when the request came from a paired register or handheld. */
  device: DeviceIdentity | null;
  /** Set when the request came from another app using an API key. */
  apiKey?: ApiKeyIdentity | null;
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

/** The signed-in person making this request. */
export function currentUserId(): string {
  const user = currentContext().user;
  if (!user) throw new InternalServerErrorException('This action needs a signed-in user');
  return user.userId;
}

/** Who to record as the actor: the person, or null for system work. */
export function actorUserId(): string | null {
  return currentContext().user?.userId ?? null;
}

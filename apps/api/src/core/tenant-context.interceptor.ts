import {
  BadRequestException,
  UnauthorizedException,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { schema, type Transaction } from '@pos/db';
import { getModule, hasPermission, type ModuleId } from '@pos/modules';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { READ_METHODS, standing } from '../billing/standing';
import { effectivePermissions } from './api-keys';
import { verifyDeviceCredential } from './device-auth';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AuthedRequest } from './auth.guard';
import { Db } from './database';
import { MODULE_KEY, NO_API_KEY, NO_TENANT_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators';
import { runWithContext, type RequestContext } from './request-context';
import { toolSetting } from './tool-settings';
import { PlatformAccess } from '../platform/platform-access';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs every authenticated request inside one database transaction with the
 * RLS settings applied, then enforces membership, permission and module
 * entitlement for tenant-scoped routes. Throwing rolls the transaction back.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
    private readonly platformAccess: PlatformAccess,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);
    if (meta<boolean>(PUBLIC_KEY)) return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const user = req.auth!;
    const noTenant = meta<boolean>(NO_TENANT_KEY) ?? false;
    const permission = meta<string>(PERMISSION_KEY);
    const moduleId = meta<ModuleId>(MODULE_KEY);

    const apiKey = req.apiKey ?? null;
    const tenantHeader = req.headers['x-tenant-id'];
    let tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;
    if (apiKey) {
      // A key belongs to one business; the header is optional but must match.
      if (noTenant || meta<boolean>(NO_API_KEY)) throw new ForbiddenException('API keys can’t be used for this; sign in instead');
      if (tenantId && tenantId !== apiKey.tenantId) throw new ForbiddenException('This API key belongs to a different business');
      tenantId = apiKey.tenantId;
      if (apiKey.readOnly && !READ_METHODS.has(req.method)) throw new ForbiddenException('This API key is read-only');
    }
    if (!noTenant && (!tenantId || !UUID.test(tenantId))) {
      throw new BadRequestException('X-Tenant-Id header with a business id is required');
    }

    return from(
      this.db.pool.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${user.userId}, true)`);
        const ctx: RequestContext = { user, tx, tenant: null, device: null, apiKey };

        if (!noTenant) {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenantId!}, true)`);
          const [membership] = await tx
            .select({
              membershipId: schema.memberships.id,
              roleId: schema.roles.id,
              roleKey: schema.roles.key,
              permissions: schema.roles.permissions,
            })
            .from(schema.memberships)
            .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
            .where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.status, 'active')));
          // RLS already limits rows to the selected business, so no row means no access...
          if (!membership) {
            // ...unless Ample POS staff opened a support view of this business: read-only, as its owner.
            const support = apiKey ? null : await this.supportSession(tx, user.userId);
            if (!support) {
              throw new ForbiddenException(
                apiKey ? 'The person who created this API key is no longer part of the business' : 'You are not a member of this business',
              );
            }
            if (!READ_METHODS.has(req.method)) {
              throw new HttpException({ statusCode: 403, code: 'support_read_only', message: 'Support view is read-only: changes can’t be made here' }, 403);
            }
            ctx.tenant = { tenantId: tenantId!, membershipId: NIL_UUID, roleId: NIL_UUID, roleKey: 'support', permissions: ['*'], supportSessionId: support };
            if (moduleId) await this.requireModule(tx, moduleId);
            return runWithContext(ctx, () => lastValueFrom(next.handle(), { defaultValue: undefined }));
          }
          // An API key gets what it was given, never more than its creator has now.
          const permissions = apiKey ? effectivePermissions(apiKey.permissions, membership.permissions) : membership.permissions;
          ctx.tenant = { tenantId: tenantId!, ...membership, permissions };

          // A business suspended by Ample POS can't be used until it's restored.
          const [tenant] = await tx.select({ suspendedAt: schema.tenants.suspendedAt, reason: schema.tenants.suspendedReason }).from(schema.tenants);
          if (tenant?.suspendedAt) {
            throw new HttpException(
              {
                statusCode: 403,
                code: 'business_suspended',
                message: `This business is suspended${tenant.reason ? `: ${tenant.reason}` : ''}. Contact Ample POS support.`,
              },
              403,
            );
          }

          const credential = req.headers['x-device-credential'];
          if (typeof credential === 'string') {
            ctx.device = await verifyDeviceCredential(tx, credential);
            if (!ctx.device) throw new UnauthorizedException('This device is not recognized or has been revoked');
          }

          if (permission && !hasPermission(permissions, permission)) {
            throw new ForbiddenException(`Missing permission: ${permission}`);
          }
          if (moduleId) {
            const [entitlement] = await tx
              .select({ enabled: schema.tenantModules.enabled, comped: schema.tenantModules.comped })
              .from(schema.tenantModules)
              .where(eq(schema.tenantModules.moduleId, moduleId));
            if (!entitlement?.enabled) {
              throw new ForbiddenException(`${getModule(moduleId).name} is not enabled for this business`);
            }
            const tool = await toolSetting(tx, moduleId);
            if (!tool.available) throw new ForbiddenException(`${getModule(moduleId).name} is temporarily unavailable`);
            // Paid tools turn read-only once the trial is over without a working subscription.
            if (tool.priceMinor > 0 && !entitlement.comped && !READ_METHODS.has(req.method)) {
              const [billing] = await tx.select().from(schema.tenantBilling);
              if (billing && standing(billing) === 'lapsed') {
                throw new HttpException(
                  {
                    statusCode: 402,
                    code: 'subscription_required',
                    message: `Your free trial has ended. Subscribe in Billing to keep making changes in ${getModule(moduleId).name}.`,
                  },
                  402,
                );
              }
            }
          }
        }

        return runWithContext(ctx, () => lastValueFrom(next.handle(), { defaultValue: undefined }));
      }),
    );
  }

  /** The signed-in admin's live support session for the selected business, if they are still a platform admin. */
  private async supportSession(tx: Transaction, userId: string): Promise<string | null> {
    const [session] = await tx
      .select({ id: schema.platformSupportSessions.id })
      .from(schema.platformSupportSessions)
      .where(and(isNull(schema.platformSupportSessions.endedAt), gt(schema.platformSupportSessions.expiresAt, sql`now()`)))
      .limit(1);
    if (!session) return null;
    return (await this.platformAccess.check(tx, userId)).ok ? session.id : null;
  }

  /** A support view still only shows tools the business has on. */
  private async requireModule(tx: Transaction, moduleId: ModuleId) {
    const [entitlement] = await tx
      .select({ enabled: schema.tenantModules.enabled })
      .from(schema.tenantModules)
      .where(eq(schema.tenantModules.moduleId, moduleId));
    if (!entitlement?.enabled) throw new ForbiddenException(`${getModule(moduleId).name} is not enabled for this business`);
  }
}

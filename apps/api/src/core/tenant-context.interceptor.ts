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
import { schema } from '@pos/db';
import { getModule, hasPermission, type ModuleId } from '@pos/modules';
import { and, eq, sql } from 'drizzle-orm';
import { READ_METHODS, standing } from '../billing/standing';
import { verifyDeviceCredential } from './device-auth';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AuthedRequest } from './auth.guard';
import { Db } from './database';
import { MODULE_KEY, NO_TENANT_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators';
import { runWithContext, type RequestContext } from './request-context';

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

    const tenantHeader = req.headers['x-tenant-id'];
    const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;
    if (!noTenant && (!tenantId || !UUID.test(tenantId))) {
      throw new BadRequestException('X-Tenant-Id header with a business id is required');
    }

    return from(
      this.db.pool.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${user.userId}, true)`);
        const ctx: RequestContext = { user, tx, tenant: null, device: null };

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
          // RLS already limits rows to the selected business, so no row means no access.
          if (!membership) throw new ForbiddenException('You are not a member of this business');
          ctx.tenant = { tenantId: tenantId!, ...membership };

          const credential = req.headers['x-device-credential'];
          if (typeof credential === 'string') {
            ctx.device = await verifyDeviceCredential(tx, credential);
            if (!ctx.device) throw new UnauthorizedException('This device is not recognized or has been revoked');
          }

          if (permission && !hasPermission(membership.permissions, permission)) {
            throw new ForbiddenException(`Missing permission: ${permission}`);
          }
          if (moduleId) {
            const [entitlement] = await tx
              .select({ enabled: schema.tenantModules.enabled })
              .from(schema.tenantModules)
              .where(eq(schema.tenantModules.moduleId, moduleId));
            if (!entitlement?.enabled) {
              throw new ForbiddenException(`${getModule(moduleId).name} is not enabled for this business`);
            }
            // Paid tools turn read-only once the trial is over without a working subscription.
            if (getModule(moduleId).monthlyPriceMinor > 0 && !READ_METHODS.has(req.method)) {
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
}

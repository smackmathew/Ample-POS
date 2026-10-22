import { Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';
import { schema } from '@pos/db';
import { SYSTEM_ROLES } from '@pos/modules';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuthService } from '../core/auth.service';
import { Db } from '../core/database';
import { NoTenant, Public } from '../core/decorators';
import { currentContext, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const devTokenBody = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(100).optional(),
});

const createTenantBody = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, numbers and single dashes')
    .min(3)
    .max(48),
});

@Controller()
export class IdentityController {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  /** Stand-in for a real identity provider while AUTH_MODE=dev. */
  @Public()
  @Post('dev/token')
  async devToken(@Body(new ZodPipe(devTokenBody)) body: z.infer<typeof devTokenBody>) {
    if (!this.auth.devMode) throw new NotFoundException();
    return { token: await this.auth.issueDevToken(body.email, body.name ?? null) };
  }

  @NoTenant()
  @Get('me')
  async me() {
    const { tx } = currentContext();
    const userId = currentUserId();
    const [profile] = await tx
      .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const tenants = await tx.execute<{ tenant_id: string; name: string; slug: string; role_key: string; role_name: string }>(
      sql`select * from app_my_tenants()`,
    );
    return {
      user: profile,
      tenants: tenants.map((t) => ({ id: t.tenant_id, name: t.name, slug: t.slug, role: { key: t.role_key, name: t.role_name } })),
    };
  }

  @NoTenant()
  @Post('tenants')
  async createTenant(@Body(new ZodPipe(createTenantBody)) body: z.infer<typeof createTenantBody>) {
    const roles = JSON.stringify(SYSTEM_ROLES);
    const [row] = await this.db.tx.execute<{ id: string }>(
      sql`select app_create_tenant(${body.name}, ${body.slug}, ${roles}::jsonb) as id`,
    );
    return { id: row!.id, name: body.name, slug: body.slug };
  }
}

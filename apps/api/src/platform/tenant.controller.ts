import { Body, Controller, Get, Patch } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission, MODULES } from '@pos/modules';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { enabledModuleIds } from './modules.controller';

const updateTenantBody = z.object({ name: z.string().trim().min(1).max(100) });

const PLATFORM_NAV = [
  { label: 'Tools', path: '/tools', permission: 'modules.manage' },
  { label: 'Locations', path: '/locations' },
  { label: 'Devices', path: '/devices', permission: 'devices.manage' },
  { label: 'Team', path: '/team', permission: 'members.read' },
  { label: 'Roles', path: '/roles', permission: 'roles.manage' },
  { label: 'Audit log', path: '/audit', permission: 'audit.read' },
];

@Controller()
export class TenantController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get('tenant')
  async current() {
    const membership = currentTenant();
    const [tenant] = await this.db.tx.select().from(schema.tenants);
    return {
      tenant,
      membership: {
        id: membership.membershipId,
        role: { id: membership.roleId, key: membership.roleKey },
        permissions: membership.permissions,
      },
      enabledModules: [...(await enabledModuleIds(this.db))],
    };
  }

  @RequirePermission('tenant.manage')
  @Patch('tenant')
  async update(@Body(new ZodPipe(updateTenantBody)) body: z.infer<typeof updateTenantBody>) {
    const { tenantId } = currentTenant();
    const [tenant] = await this.db.tx
      .update(schema.tenants)
      .set({ name: body.name })
      .where(eq(schema.tenants.id, tenantId))
      .returning();
    await this.events.record('tenant.updated', { type: 'tenant', id: tenantId }, { name: body.name });
    return tenant;
  }

  /** Navigation for the admin hub: platform pages plus enabled modules, filtered by permission. */
  @Get('navigation')
  async navigation() {
    const { permissions } = currentTenant();
    const enabled = await enabledModuleIds(this.db);
    const visible = (item: { permission?: string }) => !item.permission || hasPermission(permissions, item.permission);
    return {
      sections: [
        { title: 'Business', items: PLATFORM_NAV.filter(visible) },
        ...MODULES.filter((m) => enabled.has(m.id))
          .map((m) => ({ title: m.name, moduleId: m.id, items: m.nav.filter(visible) }))
          .filter((s) => s.items.length > 0),
      ],
    };
  }
}

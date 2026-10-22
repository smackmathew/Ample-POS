import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, asc, eq, getTableColumns, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const registerBody = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['register', 'handheld', 'kiosk']),
});

const { secretHash: _secretHash, ...publicColumns } = getTableColumns(schema.devices);

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

@Controller('devices')
@RequirePermission('devices.manage')
export class DevicesController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get()
  list() {
    return this.db.tx.select(publicColumns).from(schema.devices).orderBy(asc(schema.devices.createdAt));
  }

  /** Returns the device credential once; only its hash is stored. */
  @Post()
  async register(@Body(new ZodPipe(registerBody)) body: z.infer<typeof registerBody>) {
    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, body.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new NotFoundException('Location not found');

    const secret = randomBytes(32).toString('base64url');
    const [device] = await this.db.tx
      .insert(schema.devices)
      .values({ tenantId: currentTenant().tenantId, ...body, secretHash: hashDeviceSecret(secret) })
      .returning(publicColumns);
    await this.events.record('device.registered', { type: 'device', id: device!.id }, body);
    return { device, credential: `${device!.id}.${secret}` };
  }

  @Post(':id/revoke')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    const [device] = await this.db.tx
      .update(schema.devices)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(schema.devices.id, id), eq(schema.devices.status, 'active')))
      .returning(publicColumns);
    if (!device) throw new NotFoundException('Active device not found');
    await this.events.record('device.revoked', { type: 'device', id });
    return device;
  }
}

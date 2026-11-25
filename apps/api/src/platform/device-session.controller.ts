import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, eq } from 'drizzle-orm';
import { Db } from '../core/database';
import { currentContext } from '../core/request-context';

/** Lets a paired device confirm its credential and learn where it is and which printers it uses. */
@Controller('device')
export class DeviceSessionController {
  constructor(private readonly db: Db) {}

  @Get()
  async me() {
    const { device } = currentContext();
    if (!device) throw new UnauthorizedException('Send X-Device-Credential to identify this device');
    const [row] = await this.db.tx
      .select({
        id: schema.devices.id,
        name: schema.devices.name,
        kind: schema.devices.kind,
        location: { id: schema.locations.id, name: schema.locations.name, timezone: schema.locations.timezone },
      })
      .from(schema.devices)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.devices.locationId))
      .where(eq(schema.devices.id, device.id));
    const p = schema.printers;
    const printers = await this.db.tx
      .select({ id: p.id, name: p.name, kind: p.kind, connection: p.connection, address: p.address, port: p.port, language: p.language, paper: p.paper })
      .from(p)
      .where(and(eq(p.registerId, device.id), eq(p.status, 'active')));
    return { ...row, printers };
  }
}

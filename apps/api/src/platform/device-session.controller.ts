import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, eq, or } from 'drizzle-orm';
import { Db } from '../core/database';
import { currentContext } from '../core/request-context';

/** Lets a paired device confirm its credential and learn where it is, and which printers and scanners it uses. */
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
      // Its own receipt printer, and every tag printer at its location.
      .where(and(eq(p.status, 'active'), or(eq(p.registerId, device.id), and(eq(p.kind, 'tag'), eq(p.locationId, device.locationId)))));
    const sc = schema.scanners;
    const scanners = await this.db.tx
      .select({ id: sc.id, name: sc.name, brand: sc.brand, model: sc.model, connection: sc.connection })
      .from(sc)
      .where(and(eq(sc.deviceId, device.id), eq(sc.status, 'active')));
    return { ...row, printers, scanners };
  }
}

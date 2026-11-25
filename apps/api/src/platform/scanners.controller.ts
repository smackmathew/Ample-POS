import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { SCANNER_CONNECTIONS, schema } from '@pos/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const createBody = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  brand: z.string().trim().max(40).nullable().optional(),
  model: z.string().trim().max(60).nullable().optional(),
  connection: z.enum(SCANNER_CONNECTIONS),
  deviceId: z.string().uuid().nullable().optional(),
});
const updateBody = createBody.omit({ locationId: true }).partial();

/**
 * Barcode scanners (Symbol/Zebra and others) at each location, attached to
 * any device: a register, a handheld or a kiosk. Devices see theirs in
 * GET /device.
 */
@Controller('scanners')
@RequirePermission('devices.manage')
export class ScannersController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get()
  list() {
    return this.db.tx.select().from(schema.scanners).where(eq(schema.scanners.status, 'active')).orderBy(asc(schema.scanners.createdAt));
  }

  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, body.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new NotFoundException('Location not found');
    await this.checkDevice(body.deviceId ?? null, body.locationId);
    const [scanner] = await this.db.tx
      .insert(schema.scanners)
      .values({
        tenantId: currentTenant().tenantId,
        locationId: body.locationId,
        name: body.name,
        brand: body.brand || null,
        model: body.model || null,
        connection: body.connection,
        deviceId: body.deviceId ?? null,
      })
      .returning();
    await this.events.record('scanner.added', { type: 'scanner', id: scanner!.id }, { connection: body.connection, deviceId: scanner!.deviceId });
    return scanner;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const existing = await this.find(id);
    if (body.deviceId !== undefined) await this.checkDevice(body.deviceId, existing.locationId);
    const [scanner] = await this.db.tx
      .update(schema.scanners)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.brand !== undefined ? { brand: body.brand || null } : {}),
        ...(body.model !== undefined ? { model: body.model || null } : {}),
        ...(body.connection !== undefined ? { connection: body.connection } : {}),
        ...(body.deviceId !== undefined ? { deviceId: body.deviceId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.scanners.id, id))
      .returning();
    await this.events.record('scanner.updated', { type: 'scanner', id }, body);
    return scanner;
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.find(id);
    await this.db.tx.update(schema.scanners).set({ status: 'archived', deviceId: null, updatedAt: new Date() }).where(eq(schema.scanners.id, id));
    await this.events.record('scanner.removed', { type: 'scanner', id });
    return { removed: true };
  }

  private async find(id: string) {
    const [scanner] = await this.db.tx
      .select()
      .from(schema.scanners)
      .where(and(eq(schema.scanners.id, id), eq(schema.scanners.status, 'active')));
    if (!scanner) throw new NotFoundException('Scanner not found');
    return scanner;
  }

  /** Any active device, as long as it's at the scanner's location. */
  private async checkDevice(deviceId: string | null, locationId: string) {
    if (!deviceId) return;
    const [device] = await this.db.tx
      .select({ locationId: schema.devices.locationId })
      .from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.status, 'active')));
    if (!device) throw new BadRequestException('Choose an active device');
    if (device.locationId !== locationId) throw new BadRequestException('The device is at a different location');
  }
}

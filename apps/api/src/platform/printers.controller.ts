import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PRINTER_CONNECTIONS, PRINTER_KINDS, PRINTER_LANGUAGES, schema } from '@pos/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

/** Which command languages fit which kind of printer. */
export const LANGUAGES_FOR: Record<(typeof PRINTER_KINDS)[number], readonly (typeof PRINTER_LANGUAGES)[number][]> = {
  receipt: ['escpos', 'star', 'system'],
  tag: ['zpl', 'epl', 'tspl', 'system'],
};

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:]+\]?$/;
const SHARE = /^(?:\\\\[^\\/]+\\.+|smb:\/\/[^/]+\/.+)$/;

const fields = {
  name: z.string().trim().min(1).max(60),
  connection: z.enum(PRINTER_CONNECTIONS),
  address: z.string().trim().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  language: z.enum(PRINTER_LANGUAGES),
  paper: z.string().trim().max(30).nullable().optional(),
  registerId: z.string().uuid().nullable().optional(),
};
const createBody = z.object({ locationId: z.string().uuid(), kind: z.enum(PRINTER_KINDS), ...fields });
const updateBody = z.object({
  name: fields.name.optional(),
  connection: fields.connection.optional(),
  address: fields.address,
  port: fields.port,
  language: fields.language.optional(),
  paper: fields.paper,
  registerId: fields.registerId,
});

type Printer = typeof schema.printers.$inferSelect;

/**
 * Receipt and tag printers for each location, and the register each one
 * prints from. Registers fetch their printers with GET /device.
 */
@Controller('printers')
@RequirePermission('devices.manage')
export class PrintersController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @Get()
  list() {
    return this.db.tx
      .select()
      .from(schema.printers)
      .where(eq(schema.printers.status, 'active'))
      .orderBy(asc(schema.printers.kind), asc(schema.printers.createdAt));
  }

  @Post()
  async create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, body.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new NotFoundException('Location not found');
    const values = await this.checked({ ...body, address: body.address ?? null, port: body.port ?? null, paper: body.paper ?? null, registerId: body.registerId ?? null });
    const [printer] = await this.save(() =>
      this.db.tx
        .insert(schema.printers)
        .values({ tenantId: currentTenant().tenantId, locationId: body.locationId, kind: body.kind, ...values })
        .returning(),
    );
    await this.events.record('printer.added', { type: 'printer', id: printer!.id }, { kind: body.kind, connection: body.connection, registerId: values.registerId });
    return printer;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const existing = await this.find(id);
    const merged = {
      kind: existing.kind,
      locationId: existing.locationId,
      name: body.name ?? existing.name,
      connection: body.connection ?? existing.connection,
      address: body.address !== undefined ? body.address : existing.address,
      port: body.port !== undefined ? body.port : existing.port,
      language: body.language ?? existing.language,
      paper: body.paper !== undefined ? body.paper : existing.paper,
      registerId: body.registerId !== undefined ? body.registerId : existing.registerId,
    };
    const values = await this.checked(merged);
    const [printer] = await this.save(() =>
      this.db.tx
        .update(schema.printers)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.printers.id, id))
        .returning(),
    );
    await this.events.record('printer.updated', { type: 'printer', id }, body);
    return printer;
  }

  /** Removes the printer from the location and its register. */
  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.find(id);
    await this.db.tx.update(schema.printers).set({ status: 'archived', registerId: null, updatedAt: new Date() }).where(eq(schema.printers.id, id));
    await this.events.record('printer.removed', { type: 'printer', id });
    return { removed: true };
  }

  private async find(id: string): Promise<Printer> {
    const [printer] = await this.db.tx
      .select()
      .from(schema.printers)
      .where(and(eq(schema.printers.id, id), eq(schema.printers.status, 'active')));
    if (!printer) throw new NotFoundException('Printer not found');
    return printer;
  }

  /** Checks the connection details, language and register, and returns what to store. */
  private async checked(p: {
    kind: Printer['kind'];
    locationId: string;
    name: string;
    connection: Printer['connection'];
    address: string | null;
    port: number | null;
    language: Printer['language'];
    paper: string | null;
    registerId: string | null;
  }) {
    const address = p.address?.trim() || null;
    let port: number | null = null;
    if (p.connection === 'ip') {
      if (!address || !HOST.test(address)) throw new BadRequestException('Enter the printer’s IP address or host name, e.g. 192.168.1.50');
      port = p.port ?? 9100;
    } else if (p.connection === 'network_share') {
      if (!address || !SHARE.test(address)) throw new BadRequestException('Enter the share path, e.g. \\\\FRONT-PC\\Receipt or smb://front-pc/receipt');
    }
    if (!LANGUAGES_FOR[p.kind].includes(p.language)) {
      throw new BadRequestException(`A ${p.kind} printer uses ${LANGUAGES_FOR[p.kind].join(', ')}`);
    }
    if (p.registerId) {
      const [register] = await this.db.tx
        .select({ kind: schema.devices.kind, locationId: schema.devices.locationId })
        .from(schema.devices)
        .where(and(eq(schema.devices.id, p.registerId), eq(schema.devices.status, 'active')));
      if (!register || register.kind !== 'register') throw new BadRequestException('Choose an active register');
      if (register.locationId !== p.locationId) throw new BadRequestException('The register is at a different location');
    }
    return { name: p.name, connection: p.connection, address, port, language: p.language, paper: p.paper?.trim() || null, registerId: p.registerId };
  }

  /** A clear 409 when the register already has a printer of this kind. */
  private async save<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await this.db.tx.transaction(() => run());
    } catch (err) {
      for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
        if ((e as { constraint_name?: string }).constraint_name === 'printers_one_per_register') {
          throw new ConflictException('That register already has a printer of this kind. Unassign it first.');
        }
      }
      throw err;
    }
  }
}

import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { schema, PURCHASE_ORDER_STATUSES } from '@pos/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { Mailer } from '../core/mailer';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { PurchasingService } from './purchasing.service';

const uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const supplierBody = z.object({
  name: z.string().trim().min(1, 'Enter the supplier’s name').max(120),
  contactName: optionalText(120),
  email: z
    .string()
    .trim()
    .max(254)
    .transform((v) => v.toLowerCase())
    .pipe(z.union([z.literal(''), z.string().email('Enter a valid email')]))
    .optional()
    .transform((v) => v || null),
  phone: optionalText(40),
  notes: optionalText(1000),
});
const supplierPatch = supplierBody.partial().extend({ archived: z.boolean().optional() });

const draftBody = z.object({
  supplierId: uuid,
  locationId: uuid,
  note: optionalText(1000),
  expectedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-01')
    .optional()
    .nullable()
    .transform((v) => v || null),
  lines: z
    .array(z.object({ variantId: uuid, quantity: z.number().int().min(1).max(1_000_000), unitCostMinor: z.number().int().min(0).max(100_000_000) }))
    .max(500)
    .default([]),
});
const listQuery = z.object({
  status: z.enum([...PURCHASE_ORDER_STATUSES, 'open']).optional(),
  supplierId: uuid.optional(),
  locationId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const orderBody = z.object({ email: z.boolean().default(false), message: z.string().trim().max(2000).optional() });
const receiveBody = z.object({
  id: uuid,
  lines: z.array(z.object({ lineId: uuid, quantity: z.number().int().min(0).max(1_000_000) })).min(1).max(500),
  updateCosts: z.boolean().default(true),
  note: optionalText(500),
});
const lowStockQuery = z.object({ locationId: uuid, atOrBelow: z.coerce.number().int().min(0).max(100_000).default(0) });

@Controller('suppliers')
@RequireModule('purchasing')
export class SuppliersController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @RequirePermission('purchasing.receive')
  @Get()
  list(@Query('archived') archived?: string) {
    const s = schema.suppliers;
    return this.db.tx
      .select({
        id: s.id,
        name: s.name,
        contactName: s.contactName,
        email: s.email,
        phone: s.phone,
        notes: s.notes,
        archivedAt: s.archivedAt,
        openOrders: sql<number>`(select count(*) from purchase_orders po where po.supplier_id = suppliers.id and po.status in ('ordered', 'partially_received'))`.mapWith(Number),
      })
      .from(s)
      .where(archived === 'true' ? undefined : isNull(s.archivedAt))
      .orderBy(asc(sql`lower(${s.name})`));
  }

  @RequirePermission('purchasing.manage')
  @Post()
  async create(@Body(new ZodPipe(supplierBody)) body: z.infer<typeof supplierBody>) {
    const [supplier] = await this.db.tx
      .insert(schema.suppliers)
      .values({ tenantId: currentTenant().tenantId, ...body })
      .returning()
      .catch((err) => {
        throw duplicateName(err);
      });
    await this.events.audit('supplier.created', { type: 'supplier', id: supplier!.id }, { name: supplier!.name });
    return supplier;
  }

  @RequirePermission('purchasing.manage')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(supplierPatch)) body: z.infer<typeof supplierPatch>) {
    const { archived, ...fields } = body;
    const [supplier] = await this.db.tx
      .update(schema.suppliers)
      .set({ ...fields, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }), updatedAt: new Date() })
      .where(eq(schema.suppliers.id, id))
      .returning()
      .catch((err) => {
        throw duplicateName(err);
      });
    if (!supplier) throw new NotFoundException('Supplier not found');
    await this.events.audit('supplier.updated', { type: 'supplier', id }, { fields: Object.keys(body) });
    return supplier;
  }
}

function duplicateName(err: unknown): unknown {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return new ConflictException('You already have a supplier with that name');
  }
  return err;
}

@Controller('purchase-orders')
@RequireModule('purchasing')
export class PurchaseOrdersController {
  constructor(
    private readonly db: Db,
    private readonly purchasing: PurchasingService,
    private readonly mailer: Mailer,
    private readonly events: Events,
  ) {}

  @RequirePermission('purchasing.receive')
  @Get()
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const po = schema.purchaseOrders;
    const rows = await this.db.tx
      .select({
        id: po.id,
        number: po.number,
        status: po.status,
        supplierId: po.supplierId,
        supplierName: schema.suppliers.name,
        locationId: po.locationId,
        locationName: schema.locations.name,
        expectedOn: po.expectedOn,
        orderedAt: po.orderedAt,
        createdAt: po.createdAt,
        totalMinor: sql<number>`(select coalesce(sum(unit_cost_minor * quantity_ordered), 0) from purchase_order_lines l where l.purchase_order_id = purchase_orders.id)`.mapWith(Number),
        itemCount: sql<number>`(select count(*) from purchase_order_lines l where l.purchase_order_id = purchase_orders.id)`.mapWith(Number),
      })
      .from(po)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, po.supplierId))
      .innerJoin(schema.locations, eq(schema.locations.id, po.locationId))
      .where(
        and(
          q.status === 'open' ? sql`${po.status} in ('draft', 'ordered', 'partially_received')` : q.status ? eq(po.status, q.status) : undefined,
          q.supplierId ? eq(po.supplierId, q.supplierId) : undefined,
          q.locationId ? eq(po.locationId, q.locationId) : undefined,
        ),
      )
      .orderBy(desc(po.number))
      .limit(q.limit);
    return rows.map((r) => ({ ...r, reference: `PO-${r.number}` }));
  }

  @RequirePermission('purchasing.manage')
  @Get('low-stock')
  lowStock(@Query(new ZodPipe(lowStockQuery)) q: z.infer<typeof lowStockQuery>) {
    return this.purchasing.lowStock(q.locationId, q.atOrBelow);
  }

  @RequirePermission('purchasing.manage')
  @Post()
  create(@Body(new ZodPipe(draftBody)) body: z.infer<typeof draftBody>) {
    return this.purchasing.create(body);
  }

  @RequirePermission('purchasing.receive')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.get(id);
  }

  @RequirePermission('purchasing.manage')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(draftBody)) body: z.infer<typeof draftBody>) {
    return this.purchasing.update(id, body);
  }

  /** Places the order: marks it ordered, and emails it to the supplier if asked. */
  @RequirePermission('purchasing.manage')
  @Post(':id/order')
  @HttpCode(200)
  async order(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(orderBody)) body: z.infer<typeof orderBody>) {
    let emailedTo: string | null = null;
    if (body.email) {
      if (!this.mailer.enabled) throw new ConflictException({ code: 'email_off', message: 'Email isn’t set up, so mark the order as placed and send it yourself.' });
      const draft = await this.purchasing.get(id);
      if (!draft.supplier.email) throw new ConflictException('Add an email address for this supplier first');
      emailedTo = draft.supplier.email;
    }
    await this.purchasing.markOrdered(id);
    const order = await this.purchasing.get(id);
    if (emailedTo) {
      const [tenant] = await this.db.tx.select({ name: schema.tenants.name, currency: schema.tenants.currency }).from(schema.tenants);
      const { subject, text } = orderEmail(order, tenant!, body.message);
      await this.mailer.send(emailedTo, subject, text);
      await this.events.audit('purchase_order.emailed', { type: 'purchase_order', id }, { to: emailedTo });
    }
    return { ...order, emailedTo };
  }

  @RequirePermission('purchasing.receive')
  @Post(':id/receive')
  receive(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(receiveBody)) body: z.infer<typeof receiveBody>) {
    return this.purchasing.receive(id, body);
  }

  @RequirePermission('purchasing.manage')
  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.close(id);
  }

  @RequirePermission('purchasing.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.cancel(id);
  }
}

type OrderView = Awaited<ReturnType<PurchasingService['get']>>;

/** The order as a plain-text email the supplier can read and reply to. */
export function orderEmail(order: OrderView, tenant: { name: string; currency: string }, message?: string) {
  const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: tenant.currency }).format(minor / 100);
  const subject = `Purchase order ${order.reference} from ${tenant.name}`;
  const text = [
    `Hello${order.supplier.contactName ? ` ${order.supplier.contactName}` : ''},`,
    '',
    message || `Please send the items below to ${order.locationName}.`,
    '',
    `Order: ${order.reference}`,
    `Deliver to: ${order.locationName}`,
    ...(order.expectedOn ? [`Needed by: ${order.expectedOn}`] : []),
    ...(order.note ? [`Note: ${order.note}`] : []),
    '',
    ...order.lines.map((l) => `${l.quantityOrdered} × ${l.description}${l.sku ? ` (${l.sku})` : ''} @ ${money(l.unitCostMinor)} = ${money(l.unitCostMinor * l.quantityOrdered)}`),
    '',
    `Total: ${money(order.totalMinor)}`,
    '',
    `Thank you,`,
    tenant.name,
  ].join('\n');
  return { subject, text };
}

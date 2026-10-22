import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission } from '@pos/modules';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { SalesService } from './sales.service';

const uuid = z.string().uuid();
const minor = z.number().int().min(0).max(1_000_000_000_00);

const openRegisterBody = z.object({ locationId: uuid, openingFloatMinor: minor });
const closeRegisterBody = z.object({ countedCashMinor: minor });
const registersQuery = z.object({ status: z.enum(['open', 'closed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const saleBody = z.object({
  id: uuid,
  registerSessionId: uuid,
  lines: z
    .array(z.object({ variantId: uuid, quantity: z.number().int().min(1).max(10_000), discountMinor: minor.default(0) }))
    .min(1)
    .max(200),
  note: z.string().trim().max(500).optional(),
});

const paymentBody = z.discriminatedUnion('method', [
  z.object({ id: uuid, method: z.literal('cash'), tenderedMinor: z.number().int().min(1).max(1_000_000_000_00) }),
  z.object({ id: uuid, method: z.literal('card'), amountMinor: z.number().int().min(1).optional() }),
]);

const simulateBody = z.object({ outcome: z.enum(['approve', 'decline']) });

const refundBody = z.object({
  id: uuid,
  lines: z.array(z.object({ saleLineId: uuid, quantity: z.number().int().min(1) })).min(1).max(200),
  restock: z.boolean(),
  reason: z.string().trim().max(500).optional(),
  registerSessionId: uuid.optional(),
});

const salesQuery = z.object({
  before: z.string().datetime().optional(),
  status: z.enum(['open', 'completed', 'voided']).optional(),
  registerSessionId: uuid.optional(),
  receipt: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('registers')
@RequireModule('pos')
export class RegistersController {
  constructor(
    private readonly sales: SalesService,
    private readonly db: Db,
  ) {}

  @RequirePermission('pos.sell')
  @Post('sessions')
  open(@Body(new ZodPipe(openRegisterBody)) body: z.infer<typeof openRegisterBody>) {
    return this.sales.openRegister(body);
  }

  @RequirePermission('pos.sell')
  @Get('sessions/current')
  async current() {
    return { session: await this.sales.currentRegister(), paymentsProvider: this.sales.providerName };
  }

  /** Managers see every register; cashiers see the ones they opened. */
  @RequirePermission('pos.sell')
  @Get('sessions')
  async list(@Query(new ZodPipe(registersQuery)) q: z.infer<typeof registersQuery>) {
    const { permissions } = currentTenant();
    const r = schema.registerSessions;
    const mine = hasPermission(permissions, 'pos.register.manage') ? undefined : sql`${r.openedBy} = current_setting('app.user_id')::uuid`;
    const rows = await this.db.tx
      .select({ id: r.id })
      .from(r)
      .where(and(q.status ? eq(r.status, q.status) : undefined, mine))
      .orderBy(desc(r.openedAt))
      .limit(q.limit);
    return Promise.all(rows.map((row) => this.sales.registerSummary(row.id)));
  }

  @RequirePermission('pos.sell')
  @Get('sessions/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.registerSummary(id);
  }

  @RequirePermission('pos.sell')
  @Post('sessions/:id/close')
  close(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(closeRegisterBody)) body: z.infer<typeof closeRegisterBody>) {
    return this.sales.closeRegister(id, body.countedCashMinor);
  }
}

@Controller('sales')
@RequireModule('pos')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly db: Db,
  ) {}

  @RequirePermission('pos.sell')
  @Post()
  create(@Body(new ZodPipe(saleBody)) body: z.infer<typeof saleBody>) {
    return this.sales.createSale(body);
  }

  @RequirePermission('pos.sell')
  @Get()
  async list(@Query(new ZodPipe(salesQuery)) q: z.infer<typeof salesQuery>) {
    const s = schema.sales;
    const rows = await this.db.tx
      .select({
        id: s.id,
        status: s.status,
        receiptNumber: s.receiptNumber,
        totalMinor: s.totalMinor,
        currency: s.currency,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
        locationName: schema.locations.name,
        cashier: schema.users.displayName,
        cashierEmail: schema.users.email,
        refundedMinor: sql<number>`(select coalesce(sum(amount_minor), 0) from refunds r where r.sale_id = sales.id)`.mapWith(Number),
      })
      .from(s)
      .innerJoin(schema.locations, eq(schema.locations.id, s.locationId))
      .leftJoin(schema.users, eq(schema.users.id, s.createdBy))
      .where(
        and(
          q.status ? eq(s.status, q.status) : undefined,
          q.registerSessionId ? eq(s.registerSessionId, q.registerSessionId) : undefined,
          q.receipt ? eq(s.receiptNumber, q.receipt) : undefined,
          q.before ? lt(s.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(s.createdAt))
      .limit(q.limit);
    return { sales: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.createdAt.toISOString() : null };
  }

  @RequirePermission('pos.sell')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.getSale(id);
  }

  @RequirePermission('pos.sell')
  @Post(':id/payments')
  pay(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(paymentBody)) body: z.infer<typeof paymentBody>) {
    return this.sales.addPayment(id, body);
  }

  @RequirePermission('pos.sell')
  @Post(':id/payments/:paymentId/sync')
  sync(@Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.sales.syncPayment(id, paymentId);
  }

  @RequirePermission('pos.sell')
  @Post(':id/payments/:paymentId/cancel')
  cancelPayment(@Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.sales.cancelPayment(id, paymentId);
  }

  /** Only with PAYMENTS_PROVIDER=simulated: stands in for the customer tapping a card. */
  @RequirePermission('pos.sell')
  @Post(':id/payments/:paymentId/simulate')
  simulate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodPipe(simulateBody)) body: z.infer<typeof simulateBody>,
  ) {
    return this.sales.simulateCardPresent(id, paymentId, body.outcome);
  }

  @RequirePermission('pos.sell')
  @Post(':id/void')
  void(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.voidSale(id);
  }

  @RequirePermission('pos.refund')
  @Post(':id/refunds')
  refund(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(refundBody)) body: z.infer<typeof refundBody>) {
    return this.sales.refund(id, body);
  }
}


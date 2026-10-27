import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { hasPermission } from '@pos/modules';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentContext, currentTenant, currentUserId } from '../core/request-context';
import { LedgerService } from '../inventory/ledger.service';
import { CARD_PROVIDER, ProviderUnavailableError, type CardPaymentProvider, type ProviderPayment } from '../payments/provider';
import { SimulatedCardProvider } from '../payments/simulated.provider';
import { allocateRefund, priceLine, refundAmountForLine, sumPrices } from './pricing';

type Session = typeof schema.registerSessions.$inferSelect;
type Sale = typeof schema.sales.$inferSelect;
type Payment = typeof schema.payments.$inferSelect;

export interface SaleInput {
  id: string;
  registerSessionId: string;
  lines: { variantId: string; quantity: number; discountMinor: number }[];
  note?: string;
}

export interface PaymentInput {
  id: string;
  method: 'cash' | 'card';
  /** Card: amount to charge (defaults to the amount due). */
  amountMinor?: number;
  /** Cash: what the customer handed over. */
  tenderedMinor?: number;
}

export interface RefundInput {
  id: string;
  lines: { saleLineId: string; quantity: number }[];
  restock: boolean;
  reason?: string;
  /** Required when any of the refund is paid back in cash: the drawer it comes from. */
  registerSessionId?: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

@Injectable()
export class SalesService {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    private readonly ledger: LedgerService,
    @Inject(CARD_PROVIDER) private readonly provider: CardPaymentProvider,
  ) {}

  /** Which card processor is configured, so registers can offer the simulator. */
  get providerName(): string {
    return this.provider.name;
  }

  // Register sessions --------------------------------------------------------

  async openRegister(input: { locationId: string; openingFloatMinor: number }) {
    const { device } = currentContext();
    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, input.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new NotFoundException('Location not found or archived');
    if (device && device.locationId !== input.locationId) throw new BadRequestException('This device belongs to a different location');

    const [existing] = await this.db.tx
      .select()
      .from(schema.registerSessions)
      .where(
        and(
          eq(schema.registerSessions.status, 'open'),
          device ? eq(schema.registerSessions.deviceId, device.id) : and(isNull(schema.registerSessions.deviceId), eq(schema.registerSessions.openedBy, currentUserId())),
        ),
      );
    if (existing) throw new ConflictException({ message: 'A register is already open here. Close it first.', sessionId: existing.id });

    const [session] = await this.db.tx
      .insert(schema.registerSessions)
      .values({
        tenantId: currentTenant().tenantId,
        locationId: input.locationId,
        deviceId: device?.id ?? null,
        openingFloatMinor: input.openingFloatMinor,
        openedBy: currentUserId(),
      })
      .returning();
    await this.events.record('register.opened', { type: 'registerSession', id: session!.id }, input);
    return this.registerSummary(session!.id);
  }

  /** The caller's open register: this device's, or on the web the one this person opened. */
  async currentRegister() {
    const { device } = currentContext();
    const [session] = await this.db.tx
      .select({ id: schema.registerSessions.id })
      .from(schema.registerSessions)
      .where(
        and(
          eq(schema.registerSessions.status, 'open'),
          device ? eq(schema.registerSessions.deviceId, device.id) : and(isNull(schema.registerSessions.deviceId), eq(schema.registerSessions.openedBy, currentUserId())),
        ),
      );
    return session ? this.registerSummary(session.id) : null;
  }

  async registerSummary(id: string) {
    const [session] = await this.db.tx
      .select({ session: schema.registerSessions, locationName: schema.locations.name })
      .from(schema.registerSessions)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.registerSessions.locationId))
      .where(eq(schema.registerSessions.id, id));
    if (!session) throw new NotFoundException('Register session not found');
    const [totals] = await this.db.tx.execute<{
      sales_count: string;
      gross_minor: string;
      cash_minor: string;
      card_minor: string;
      cash_refunds_minor: string;
    }>(sql`
      select
        (select count(*) from sales where register_session_id = ${id} and status = 'completed') as sales_count,
        (select coalesce(sum(total_minor), 0) from sales where register_session_id = ${id} and status = 'completed') as gross_minor,
        (select coalesce(sum(p.amount_minor), 0) from payments p join sales s on s.id = p.sale_id
           where s.register_session_id = ${id} and p.method = 'cash' and p.status = 'succeeded') as cash_minor,
        (select coalesce(sum(p.amount_minor), 0) from payments p join sales s on s.id = p.sale_id
           where s.register_session_id = ${id} and p.method = 'card' and p.status = 'succeeded') as card_minor,
        (select coalesce(sum(rp.amount_minor), 0) from refund_payments rp
           join refunds r on r.id = rp.refund_id join payments p on p.id = rp.payment_id
           where r.register_session_id = ${id} and p.method = 'cash' and rp.status = 'succeeded') as cash_refunds_minor
    `);
    const n = (v: string | undefined) => Number(v ?? 0);
    const cash = n(totals?.cash_minor);
    const cashRefunds = n(totals?.cash_refunds_minor);
    const expectedCashMinor = session.session.openingFloatMinor + cash - cashRefunds;
    return {
      ...session.session,
      locationName: session.locationName,
      totals: {
        salesCount: n(totals?.sales_count),
        grossMinor: n(totals?.gross_minor),
        cashMinor: cash,
        cardMinor: n(totals?.card_minor),
        cashRefundsMinor: cashRefunds,
        expectedCashMinor: session.session.status === 'closed' ? session.session.expectedCashMinor : expectedCashMinor,
      },
      varianceMinor:
        session.session.status === 'closed' && session.session.countedCashMinor !== null && session.session.expectedCashMinor !== null
          ? session.session.countedCashMinor - session.session.expectedCashMinor
          : null,
    };
  }

  async closeRegister(id: string, countedCashMinor: number) {
    const session = await this.lockSession(id);
    if (session.status !== 'open') throw new ConflictException('This register is already closed');
    if (!this.canUseSession(session) && !hasPermission(currentTenant().permissions, 'pos.register.manage')) {
      throw new ForbiddenException('Only the cashier who opened this register, or a manager, can close it');
    }
    const unfinished = await this.db.tx
      // Written as sales.id: Drizzle leaves columns unqualified in a single-table select list,
      // which would make "id" resolve to the subquery's own payments.id.
      .select({ id: schema.sales.id, paid: sql<number>`(select count(*) from payments p where p.sale_id = sales.id and p.status in ('pending', 'succeeded'))`.mapWith(Number) })
      .from(schema.sales)
      .where(and(eq(schema.sales.registerSessionId, id), eq(schema.sales.status, 'open')));
    if (unfinished.some((s) => s.paid > 0)) throw new ConflictException('Finish or void the sales in progress before closing');
    // Abandoned carts with no payments can simply be voided.
    if (unfinished.length) {
      await this.db.tx
        .update(schema.sales)
        .set({ status: 'voided', voidedAt: new Date() })
        .where(inArray(schema.sales.id, unfinished.map((s) => s.id)));
    }

    const summary = await this.registerSummary(id);
    const expected = summary.totals.expectedCashMinor!;
    await this.db.tx
      .update(schema.registerSessions)
      .set({ status: 'closed', countedCashMinor, expectedCashMinor: expected, closedAt: new Date(), closedBy: currentUserId() })
      .where(eq(schema.registerSessions.id, id));
    await this.events.record('register.closed', { type: 'registerSession', id }, {
      countedCashMinor,
      expectedCashMinor: expected,
      varianceMinor: countedCashMinor - expected,
    });
    return this.registerSummary(id);
  }

  /** Device registers are used from that device; web registers only by the person who opened them. */
  private canUseSession(session: Session): boolean {
    const { device, user } = currentContext();
    return session.deviceId ? device?.id === session.deviceId : !device && session.openedBy === user?.userId;
  }

  private async lockSession(id: string): Promise<Session> {
    const [session] = await this.db.tx.select().from(schema.registerSessions).where(eq(schema.registerSessions.id, id)).for('update');
    if (!session) throw new NotFoundException('Register session not found');
    return session;
  }

  // Sales --------------------------------------------------------------------

  async createSale(input: SaleInput) {
    const [existing] = await this.db.tx.select({ id: schema.sales.id }).from(schema.sales).where(eq(schema.sales.id, input.id));
    if (existing) return this.getSale(input.id);

    const session = await this.lockSession(input.registerSessionId);
    if (session.status !== 'open') throw new ConflictException('This register is closed');
    if (!this.canUseSession(session)) throw new ForbiddenException('This register belongs to another cashier or device');
    if (input.lines.some((l) => l.discountMinor > 0) && !hasPermission(currentTenant().permissions, 'pos.discount')) {
      throw new ForbiddenException('Missing permission: pos.discount');
    }

    const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
    const variants = await this.db.tx
      .select({ variant: schema.productVariants, productName: schema.products.name, productStatus: schema.products.status })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(inArray(schema.productVariants.id, variantIds));
    const byId = new Map(variants.map((v) => [v.variant.id, v]));
    const unavailable = variantIds.filter((id) => {
      const v = byId.get(id);
      return !v || v.variant.status !== 'active' || v.productStatus !== 'active';
    });
    if (unavailable.length) throw new BadRequestException('Some items are no longer for sale. Refresh the catalog and try again.');

    const [location] = await this.db.tx.select({ taxRateBps: schema.locations.taxRateBps }).from(schema.locations).where(eq(schema.locations.id, session.locationId));
    const [tenant] = await this.db.tx.select({ currency: schema.tenants.currency }).from(schema.tenants);
    const taxRateBps = location!.taxRateBps;

    const priced = input.lines.map((line, position) => {
      const v = byId.get(line.variantId)!;
      try {
        return { line, v, position, price: priceLine({ unitPriceMinor: v.variant.priceMinor, quantity: line.quantity, discountMinor: line.discountMinor }, taxRateBps) };
      } catch (err) {
        throw new BadRequestException(`${v.productName}: ${(err as Error).message}`);
      }
    });
    const totals = sumPrices(priced.map((p) => p.price));

    await this.db.tx.insert(schema.sales).values({
      id: input.id,
      tenantId: session.tenantId,
      locationId: session.locationId,
      registerSessionId: session.id,
      deviceId: currentContext().device?.id ?? null,
      currency: tenant!.currency,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      taxRateBps,
      note: input.note ?? null,
      createdBy: currentUserId(),
    });
    await this.db.tx.insert(schema.saleLines).values(
      priced.map(({ line, v, position, price }) => ({
        tenantId: session.tenantId,
        saleId: input.id,
        position,
        variantId: v.variant.id,
        description: v.variant.name === 'Default' ? v.productName : `${v.productName} — ${v.variant.name}`,
        sku: v.variant.sku,
        quantity: line.quantity,
        unitPriceMinor: v.variant.priceMinor,
        discountMinor: price.discountMinor,
        taxMinor: price.taxMinor,
        totalMinor: price.totalMinor,
        trackInventory: v.variant.trackInventory,
      })),
    );
    if (totals.totalMinor === 0) await this.tryComplete(await this.lockSale(input.id));
    return this.getSale(input.id);
  }

  async getSale(id: string) {
    const [sale] = await this.db.tx.select().from(schema.sales).where(eq(schema.sales.id, id));
    if (!sale) throw new NotFoundException('Sale not found');
    const [lines, payments, refunds, refundLines, refundPayments] = await Promise.all([
      this.db.tx.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, id)).orderBy(asc(schema.saleLines.position)),
      this.db.tx.select().from(schema.payments).where(eq(schema.payments.saleId, id)).orderBy(asc(schema.payments.createdAt), asc(schema.payments.id)),
      this.db.tx.select().from(schema.refunds).where(eq(schema.refunds.saleId, id)).orderBy(asc(schema.refunds.createdAt)),
      this.db.tx
        .select({ refundId: schema.refundLines.refundId, saleLineId: schema.refundLines.saleLineId, quantity: schema.refundLines.quantity, amountMinor: schema.refundLines.amountMinor })
        .from(schema.refundLines)
        .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundLines.refundId))
        .where(eq(schema.refunds.saleId, id)),
      this.db.tx
        .select({ refundId: schema.refundPayments.refundId, paymentId: schema.refundPayments.paymentId, amountMinor: schema.refundPayments.amountMinor, status: schema.refundPayments.status })
        .from(schema.refundPayments)
        .innerJoin(schema.refunds, eq(schema.refunds.id, schema.refundPayments.refundId))
        .where(eq(schema.refunds.saleId, id)),
    ]);
    const paidMinor = sum(payments.filter((p) => p.status === 'succeeded').map((p) => p.amountMinor));
    const pendingMinor = sum(payments.filter((p) => p.status === 'pending').map((p) => p.amountMinor));
    return {
      ...sale,
      lines: lines.map((l) => {
        const refunded = refundLines.filter((r) => r.saleLineId === l.id);
        return { ...l, refundedQuantity: sum(refunded.map((r) => r.quantity)), refundedMinor: sum(refunded.map((r) => r.amountMinor)) };
      }),
      payments: payments.map(({ createdBy: _c, ...p }) => p),
      refunds: refunds.map((r) => ({
        ...r,
        lines: refundLines.filter((l) => l.refundId === r.id),
        payments: refundPayments.filter((p) => p.refundId === r.id),
      })),
      paidMinor,
      pendingMinor,
      dueMinor: Math.max(0, sale.totalMinor - paidMinor - pendingMinor),
      refundedMinor: sum(refunds.map((r) => r.amountMinor)),
    };
  }

  async addPayment(saleId: string, input: PaymentInput) {
    const [existing] = await this.db.tx.select().from(schema.payments).where(eq(schema.payments.id, input.id));
    if (existing) {
      if (existing.saleId !== saleId) throw new ConflictException('Payment id already used for another sale');
      // A retry after a lost response still needs the secret to drive the reader.
      const clientSecret =
        existing.method === 'card' && existing.status === 'pending' && existing.providerRef
          ? (await this.callProvider(() => this.provider.retrieve(existing.providerRef!))).clientSecret
          : null;
      return { payment: existing, clientSecret, sale: await this.getSale(saleId) };
    }

    const sale = await this.lockSale(saleId);
    if (sale.status !== 'open') throw new ConflictException(`This sale is ${sale.status}`);
    const session = await this.lockSession(sale.registerSessionId);
    if (!this.canUseSession(session)) throw new ForbiddenException('This sale belongs to another register');
    const due = sale.totalMinor - (await this.paidAndPending(saleId));
    if (due <= 0) throw new ConflictException('Nothing left to pay on this sale');

    const base = {
      id: input.id,
      tenantId: sale.tenantId,
      saleId,
      createdBy: currentUserId(),
      deviceId: currentContext().device?.id ?? null,
    };

    if (input.method === 'cash') {
      const tendered = input.tenderedMinor;
      if (!tendered || tendered < 1) throw new BadRequestException('Enter the cash amount received');
      const amount = Math.min(tendered, due);
      const [payment] = await this.db.tx
        .insert(schema.payments)
        .values({ ...base, method: 'cash', status: 'succeeded', amountMinor: amount, tenderedMinor: tendered, changeMinor: tendered - amount })
        .returning();
      await this.tryComplete(sale);
      return { payment: payment!, clientSecret: null, sale: await this.getSale(saleId) };
    }

    const amount = input.amountMinor ?? due;
    if (amount < 1 || amount > due) throw new BadRequestException(`Card amount must be between 0.01 and the ${due} due`);
    // The payment id doubles as the provider idempotency key: a retried request reuses the same intent.
    const intent = await this.callProvider(() =>
      this.provider.createCardPayment({
        amountMinor: amount,
        currency: sale.currency,
        idempotencyKey: input.id,
        metadata: { tenantId: sale.tenantId, saleId, paymentId: input.id },
      }),
    );
    const [payment] = await this.db.tx
      .insert(schema.payments)
      .values({
        ...base,
        method: 'card',
        status: intent.status === 'canceled' ? 'canceled' : intent.status,
        amountMinor: amount,
        provider: this.provider.name,
        providerRef: intent.ref,
        lastError: intent.error,
      })
      .returning();
    if (intent.status === 'succeeded') await this.tryComplete(sale);
    return { payment: payment!, clientSecret: intent.clientSecret, sale: await this.getSale(saleId) };
  }

  /** Asks the provider for the current state of a card payment and records it. */
  async syncPayment(saleId: string, paymentId: string) {
    const sale = await this.lockSale(saleId);
    const payment = await this.findPayment(saleId, paymentId);
    if (payment.method === 'card' && payment.status === 'pending' && payment.providerRef) {
      await this.applyProviderState(sale, payment, await this.callProvider(() => this.provider.retrieve(payment.providerRef!)));
    }
    return this.getSale(saleId);
  }

  async cancelPayment(saleId: string, paymentId: string) {
    const sale = await this.lockSale(saleId);
    const payment = await this.findPayment(saleId, paymentId);
    if (payment.method !== 'card') throw new BadRequestException('Cash payments cannot be canceled; refund the sale instead');
    if (payment.status === 'pending') {
      const state = await this.callProvider(() => this.provider.cancel(payment.providerRef!));
      await this.applyProviderState(sale, payment, state);
      if (state.status === 'succeeded') throw new ConflictException({ message: 'The card payment had already gone through', sale: await this.getSale(saleId) });
    }
    return this.getSale(saleId);
  }

  /** Development only: pretend the customer tapped a card on the simulated reader. */
  async simulateCardPresent(saleId: string, paymentId: string, outcome: 'approve' | 'decline') {
    if (!(this.provider instanceof SimulatedCardProvider)) throw new NotFoundException();
    const payment = await this.findPayment(saleId, paymentId);
    if (!payment.providerRef) throw new BadRequestException('Not a card payment');
    this.provider.present(payment.providerRef, outcome);
    return this.syncPayment(saleId, paymentId);
  }

  /** Webhook entry point: the provider says something changed for this payment. */
  async syncByProviderRef(ref: string) {
    const [payment] = await this.db.tx
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.provider, this.provider.name), eq(schema.payments.providerRef, ref)));
    if (!payment) return null;
    return this.syncPayment(payment.saleId, payment.id);
  }

  async voidSale(id: string) {
    const sale = await this.lockSale(id);
    if (sale.status === 'voided') return this.getSale(id);
    if (sale.status !== 'open') throw new ConflictException('Completed sales are refunded, not voided');
    const payments = await this.db.tx.select().from(schema.payments).where(eq(schema.payments.saleId, id));
    for (const p of payments.filter((p) => p.status === 'pending' && p.providerRef)) {
      const state = await this.callProvider(() => this.provider.cancel(p.providerRef!));
      await this.applyProviderState(sale, p, state);
    }
    const [{ paid }] = (await this.db.tx
      .select({ paid: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)`.mapWith(Number) })
      .from(schema.payments)
      .where(and(eq(schema.payments.saleId, id), eq(schema.payments.status, 'succeeded')))) as [{ paid: number }];
    if (paid > 0) throw new ConflictException('Money was already taken on this sale. Complete it and issue a refund instead.');
    await this.db.tx.update(schema.sales).set({ status: 'voided', voidedAt: new Date() }).where(eq(schema.sales.id, id));
    await this.events.record('sale.voided', { type: 'sale', id });
    return this.getSale(id);
  }

  async refund(saleId: string, input: RefundInput) {
    const [existing] = await this.db.tx.select({ saleId: schema.refunds.saleId }).from(schema.refunds).where(eq(schema.refunds.id, input.id));
    if (existing) {
      if (existing.saleId !== saleId) throw new ConflictException('Refund id already used for another sale');
      return this.getSale(saleId);
    }
    const sale = await this.lockSale(saleId);
    if (sale.status !== 'completed') throw new ConflictException('Only completed sales can be refunded');
    const current = await this.getSale(saleId);

    if (new Set(input.lines.map((l) => l.saleLineId)).size !== input.lines.length) throw new BadRequestException('Each line may appear once');
    const lines = input.lines.map((req) => {
      const line = current.lines.find((l) => l.id === req.saleLineId);
      if (!line) throw new NotFoundException('Sale line not found');
      try {
        const amountMinor = refundAmountForLine(line, { quantity: line.refundedQuantity, amountMinor: line.refundedMinor }, req.quantity);
        return { line, quantity: req.quantity, amountMinor };
      } catch (err) {
        throw new BadRequestException(`${line.description}: ${(err as Error).message}`);
      }
    });
    const amountMinor = sum(lines.map((l) => l.amountMinor));
    if (amountMinor <= 0) throw new BadRequestException('Nothing to refund');

    // What each original payment can still give back.
    const refundable = current.payments
      .filter((p) => p.status === 'succeeded')
      .map((p) => ({
        id: p.id,
        method: p.method,
        refundableMinor:
          p.amountMinor -
          sum(current.refunds.flatMap((r) => r.payments).filter((rp) => rp.paymentId === p.id && rp.status !== 'failed').map((rp) => rp.amountMinor)),
      }));
    const allocation = allocateRefund(amountMinor, refundable);
    const cashOut = sum(allocation.filter((a) => a.method === 'cash').map((a) => a.amountMinor));

    let registerSessionId: string | null = null;
    if (cashOut > 0) {
      if (!input.registerSessionId) throw new BadRequestException({ code: 'register_required', message: 'Open a register to pay this refund out in cash' });
      const session = await this.lockSession(input.registerSessionId);
      if (session.status !== 'open' || !this.canUseSession(session)) throw new ForbiddenException('Use your own open register for cash refunds');
      registerSessionId = session.id;
    }

    await this.db.tx.insert(schema.refunds).values({
      id: input.id,
      tenantId: sale.tenantId,
      saleId,
      amountMinor,
      restock: input.restock,
      reason: input.reason ?? null,
      registerSessionId,
      createdBy: currentUserId(),
    });
    await this.db.tx.insert(schema.refundLines).values(
      lines.map((l) => ({ refundId: input.id, tenantId: sale.tenantId, saleLineId: l.line.id, quantity: l.quantity, amountMinor: l.amountMinor })),
    );
    for (const a of allocation) {
      if (a.method === 'cash') {
        await this.db.tx.insert(schema.refundPayments).values({ refundId: input.id, tenantId: sale.tenantId, paymentId: a.paymentId, amountMinor: a.amountMinor, status: 'succeeded' });
        continue;
      }
      const payment = current.payments.find((p) => p.id === a.paymentId)!;
      const result = await this.callProvider(() =>
        this.provider.refund({ ref: payment.providerRef!, amountMinor: a.amountMinor, idempotencyKey: `${input.id}:${a.paymentId}` }),
      );
      if (result.status === 'failed') {
        // Nothing has been recorded yet (the transaction rolls back), so the refund can be retried or done another way.
        throw new BadGatewayException(`The card refund was declined: ${result.error ?? 'unknown reason'}`);
      }
      await this.db.tx.insert(schema.refundPayments).values({
        refundId: input.id,
        tenantId: sale.tenantId,
        paymentId: a.paymentId,
        amountMinor: a.amountMinor,
        status: result.status,
        providerRef: result.ref,
      });
    }

    if (input.restock && (await this.inventoryEnabled())) {
      const restockLines = lines.filter((l) => l.line.trackInventory);
      if (restockLines.length) {
        await this.ledger.record({
          kind: 'refund',
          reference: { type: 'refund', id: input.id },
          lines: restockLines.map((l) => ({ locationId: sale.locationId, variantId: l.line.variantId, quantityDelta: l.quantity, reason: 'return' })),
        });
      }
    }
    await this.events.record('sale.refunded', { type: 'sale', id: saleId }, {
      refundId: input.id,
      amountMinor,
      restock: input.restock,
      lines: lines.map((l) => ({ saleLineId: l.line.id, variantId: l.line.variantId, quantity: l.quantity, amountMinor: l.amountMinor })),
    });
    return this.getSale(saleId);
  }

  // Internals ----------------------------------------------------------------

  private async lockSale(id: string): Promise<Sale> {
    const [sale] = await this.db.tx.select().from(schema.sales).where(eq(schema.sales.id, id)).for('update');
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  private async findPayment(saleId: string, paymentId: string): Promise<Payment> {
    const [payment] = await this.db.tx
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.saleId, saleId)))
      .for('update');
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  private async paidAndPending(saleId: string): Promise<number> {
    const [{ total }] = (await this.db.tx
      .select({ total: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)`.mapWith(Number) })
      .from(schema.payments)
      .where(and(eq(schema.payments.saleId, saleId), inArray(schema.payments.status, ['pending', 'succeeded'])))) as [{ total: number }];
    return total;
  }

  private async applyProviderState(sale: Sale, payment: Payment, state: ProviderPayment) {
    const status = state.status;
    if (status === payment.status && state.error === payment.lastError) return;
    await this.db.tx
      .update(schema.payments)
      .set({ status, lastError: state.error, updatedAt: new Date() })
      .where(eq(schema.payments.id, payment.id));
    if (status === 'succeeded') await this.tryComplete(sale);
  }

  /** Completes the sale once succeeded payments cover the total. Caller holds the sale lock. */
  private async tryComplete(sale: Sale) {
    if (sale.status !== 'open') return;
    const [{ paid }] = (await this.db.tx
      .select({ paid: sql<number>`coalesce(sum(${schema.payments.amountMinor}), 0)`.mapWith(Number) })
      .from(schema.payments)
      .where(and(eq(schema.payments.saleId, sale.id), eq(schema.payments.status, 'succeeded')))) as [{ paid: number }];
    if (paid < sale.totalMinor) return;

    const [counter] = await this.db.tx
      .insert(schema.tenantCounters)
      .values({ tenantId: sale.tenantId, name: 'receipt', value: 1 })
      .onConflictDoUpdate({ target: [schema.tenantCounters.tenantId, schema.tenantCounters.name], set: { value: sql`${schema.tenantCounters.value} + 1` } })
      .returning({ value: schema.tenantCounters.value });
    await this.db.tx
      .update(schema.sales)
      .set({ status: 'completed', completedAt: new Date(), receiptNumber: counter!.value })
      .where(eq(schema.sales.id, sale.id));
    sale.status = 'completed';

    const lines = await this.db.tx.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, sale.id));
    const tracked = lines.filter((l) => l.trackInventory);
    if (tracked.length && (await this.inventoryEnabled())) {
      await this.ledger.record({
        kind: 'sale',
        reference: { type: 'sale', id: sale.id },
        lines: tracked.map((l) => ({ locationId: sale.locationId, variantId: l.variantId, quantityDelta: -l.quantity, reason: 'sale' })),
      });
    }
    await this.events.record('sale.completed', { type: 'sale', id: sale.id }, {
      receiptNumber: counter!.value,
      locationId: sale.locationId,
      totalMinor: sale.totalMinor,
      lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, totalMinor: l.totalMinor })),
    });
  }

  private async inventoryEnabled(): Promise<boolean> {
    const [row] = await this.db.tx
      .select({ enabled: schema.tenantModules.enabled })
      .from(schema.tenantModules)
      .where(eq(schema.tenantModules.moduleId, 'inventory'));
    return row?.enabled ?? false;
  }

  private async callProvider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        throw new BadGatewayException(`${err.message}. Nothing was recorded; retry with the same request.`);
      }
      throw err;
    }
  }
}

import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { schema } from '@pos/db';
import { receiptHtml, receiptText, type Receipt } from '@pos/receipts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { Mailer } from '../core/mailer';
import { RateLimiter } from '../core/rate-limit';
import { ZodPipe } from '../core/zod';
import { SalesService } from './sales.service';

/** Without an email, the receipt goes to the sale's customer. */
const emailBody = z.object({ email: z.string().trim().email('Enter a valid email').max(254).optional() });

/** Receipts for a sale: the data every receipt layout uses, and sending it by email. */
@Controller('sales')
@RequireModule('pos')
@RequirePermission('pos.sell')
export class ReceiptsController {
  constructor(
    private readonly db: Db,
    private readonly sales: SalesService,
    private readonly mailer: Mailer,
    private readonly limiter: RateLimiter,
    private readonly events: Events,
  ) {}

  @Get(':id/receipt')
  async receipt(@Param('id', ParseUUIDPipe) id: string): Promise<Receipt> {
    return this.build(await this.sales.getSale(id));
  }

  /** Emails the receipt to the customer. The address isn't kept, only that a receipt was sent. */
  @Post(':id/receipt/email')
  @HttpCode(200)
  async email(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(emailBody)) body: z.infer<typeof emailBody>) {
    if (!this.mailer.enabled) throw new ConflictException({ code: 'email_off', message: 'Email isn’t set up for this business yet, so receipts can only be printed.' });
    const sale = await this.sales.getSale(id);
    const to = body.email ?? sale.customer?.email;
    if (!to) throw new BadRequestException('Enter an email address to send the receipt to');
    const receipt = await this.build(sale);
    if (receipt.status !== 'completed') throw new ConflictException('Only completed sales have a receipt to send');
    this.limiter.check(`receipt:${id}`, 5, 'This receipt was just sent several times. Try again in a few minutes.');
    this.limiter.hit(`receipt:${id}`, 60 * 60_000);
    const subject = `Your receipt from ${receipt.business.name}${receipt.receiptNumber ? ` (#${receipt.receiptNumber})` : ''}`;
    await this.mailer.send(to, subject, receiptText(receipt), receiptHtml(receipt, { title: subject }));
    await this.events.audit('sale.receipt_emailed', { type: 'sale', id }, { to: to.replace(/^(.).*(@.*)$/, '$1…$2'), ...(body.email ? {} : { toCustomer: true }) });
    return { sent: true };
  }

  private async build(sale: Awaited<ReturnType<SalesService['getSale']>>): Promise<Receipt> {
    const tx = this.db.tx;
    const [[tenant], [location], [cashier]] = await Promise.all([
      tx.select({ name: schema.tenants.name, settings: schema.tenants.receiptSettings }).from(schema.tenants),
      tx
        .select({ name: schema.locations.name, address: schema.locations.address, timezone: schema.locations.timezone })
        .from(schema.locations)
        .where(eq(schema.locations.id, sale.locationId)),
      tx.select({ name: schema.users.displayName, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, sale.createdBy)),
    ]);
    const settings = tenant!.settings ?? {};
    return {
      saleId: sale.id,
      business: { name: tenant!.name, phone: settings.phone || null, website: settings.website || null, footer: settings.footer || null },
      location: { name: location!.name, address: location!.address, timezone: location!.timezone },
      receiptNumber: sale.receiptNumber,
      status: sale.status,
      issuedAt: (sale.completedAt ?? sale.createdAt).toISOString(),
      // First name only: receipts go home with customers.
      cashier: cashier?.name?.split(/\s+/)[0] ?? null,
      currency: sale.currency,
      // Lines before tax, so they add up to the subtotal; tax is its own row.
      // A loyalty reward is its own row, so lines show only their own discounts.
      lines: sale.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: l.discountMinor - l.rewardMinor,
        totalMinor: l.unitPriceMinor * l.quantity - (l.discountMinor - l.rewardMinor),
      })),
      subtotalMinor: sale.subtotalMinor,
      discountMinor: sale.discountMinor,
      rewardMinor: sale.rewardMinor,
      loyalty: sale.loyalty && sale.status === 'completed' ? { earned: sale.loyalty.earnedPoints, balance: sale.loyalty.balance } : null,
      taxMinor: sale.taxMinor,
      totalMinor: sale.totalMinor,
      payments: sale.payments
        .filter((p) => p.status === 'succeeded')
        .map((p) => ({ method: p.method, amountMinor: p.amountMinor, tenderedMinor: p.tenderedMinor, changeMinor: p.changeMinor })),
      refunds: sale.refunds.map((r) => ({ createdAt: r.createdAt.toISOString(), amountMinor: r.amountMinor, reason: r.reason })),
    };
  }
}

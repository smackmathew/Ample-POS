import { BadRequestException, Controller, Get, HttpCode, Inject, Logger, NotFoundException, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { Public, RequirePermission } from '../core/decorators';
import { runAsSystem } from '../core/system-context';
import { verifyStripeWebhook } from '../payments/stripe.provider';
import { BillingService } from './billing.service';

@Controller('billing')
@RequirePermission('billing.manage')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  summary() {
    return this.billing.summary();
  }

  /** Subscribe to the tools that are on: returns a checkout URL, or subscribes at once (simulated). */
  @Post('checkout')
  checkout() {
    return this.billing.checkout();
  }

  /** Called when the owner returns from checkout, so the page doesn't wait for the webhook. */
  @Post('refresh')
  @HttpCode(200)
  async refresh() {
    await this.billing.refresh();
    await this.billing.syncItems();
    return this.billing.summary();
  }

  @Post('portal')
  @HttpCode(200)
  async portal() {
    return { url: await this.billing.portalUrl() };
  }

  @Post('cancel')
  @HttpCode(200)
  async cancel() {
    await this.billing.setCancelAtPeriodEnd(true);
    return this.billing.summary();
  }

  @Post('resume')
  @HttpCode(200)
  async resume() {
    await this.billing.setCancelAtPeriodEnd(false);
    return this.billing.summary();
  }
}

@Controller('webhooks')
export class BillingWebhookController {
  private readonly logger = new Logger('BillingWebhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly billing: BillingService,
  ) {}

  /**
   * Subscription and invoice events from Ample POS's own Stripe account. The
   * event only tells us which customer changed; the state is re-read from Stripe.
   */
  @Public()
  @Post('stripe-billing')
  @HttpCode(200)
  async stripe(@Req() req: RawBodyRequest<Request>) {
    if (this.config.BILLING_PROVIDER !== 'stripe') throw new NotFoundException();
    const event = verifyStripeWebhook(req.rawBody?.toString('utf8') ?? '', req.headers['stripe-signature'] as string | undefined, this.config.BILLING_STRIPE_WEBHOOK_SECRET!);
    if (!event) throw new BadRequestException('Invalid signature');
    const object = event.data?.object as { id: string; object: string; customer?: string | null };
    const customer = object.object === 'customer' ? object.id : object.customer;
    if (!customer) return { received: true };

    const [row] = await this.db.pool.execute<{ tenant_id: string | null }>(sql`select app_billing_tenant('stripe', ${customer}) as tenant_id`);
    if (!row?.tenant_id) {
      this.logger.warn(`No business for customer ${customer}; ignoring ${event.type}`);
      return { received: true };
    }
    await runAsSystem(this.db, row.tenant_id, () => this.billing.refresh());
    return { received: true };
  }
}

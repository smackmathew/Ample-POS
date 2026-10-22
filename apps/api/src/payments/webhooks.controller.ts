import { BadRequestException, Controller, HttpCode, Inject, Logger, NotFoundException, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { Public } from '../core/decorators';
import { runAsSystem } from '../core/system-context';
import { SalesService } from '../sales/sales.service';
import { verifyStripeWebhook } from './stripe.provider';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger('Webhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly sales: SalesService,
  ) {}

  /**
   * Stripe payment events. We don't trust the event body for state: we look
   * up which business owns the PaymentIntent and re-read it from Stripe.
   */
  @Public()
  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() req: RawBodyRequest<Request>) {
    if (this.config.PAYMENTS_PROVIDER !== 'stripe') throw new NotFoundException();
    const event = verifyStripeWebhook(req.rawBody?.toString('utf8') ?? '', req.headers['stripe-signature'] as string | undefined, this.config.STRIPE_WEBHOOK_SECRET!);
    if (!event) throw new BadRequestException('Invalid signature');
    const object = event.data?.object;
    if (object?.object !== 'payment_intent') return { received: true };

    const [row] = await this.db.pool.execute<{ tenant_id: string | null }>(sql`select app_payment_tenant('stripe', ${object.id}) as tenant_id`);
    if (!row?.tenant_id) {
      this.logger.warn(`No payment for ${object.id}; ignoring ${event.type}`);
      return { received: true };
    }
    await runAsSystem(this.db, row.tenant_id, () => this.sales.syncByProviderRef(object.id));
    return { received: true };
  }
}

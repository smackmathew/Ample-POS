import { BadRequestException, Controller, HttpCode, Inject, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { Public } from '../core/decorators';
import { runAsSystem } from '../core/system-context';
import { SalesService } from '../sales/sales.service';
import { SECRET_BOX, type SecretBox } from '../core/secrets';
import { CardProviders } from './card-providers';
import { MerchantService } from './merchant.service';
import { verifyStripeWebhook } from './stripe.provider';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger('Webhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly sales: SalesService,
    private readonly merchant: MerchantService,
    private readonly cards: CardProviders,
    @Inject(SECRET_BOX) private readonly box: SecretBox | null,
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

  /**
   * Stripe Connect events from businesses' Express accounts: onboarding
   * progress (account.updated) and their card payments. As above, state is
   * re-read from Stripe rather than taken from the event.
   */
  @Public()
  @Post('stripe-connect')
  @HttpCode(200)
  async stripeConnect(@Req() req: RawBodyRequest<Request>) {
    if (!this.config.STRIPE_CONNECT_WEBHOOK_SECRET) throw new NotFoundException();
    const event = verifyStripeWebhook(req.rawBody?.toString('utf8') ?? '', req.headers['stripe-signature'] as string | undefined, this.config.STRIPE_CONNECT_WEBHOOK_SECRET) as
      | (ReturnType<typeof verifyStripeWebhook> & { account?: string })
      | null;
    if (!event) throw new BadRequestException('Invalid signature');
    const object = event.data?.object;
    if (object?.object === 'account' && event.account) {
      const [row] = await this.db.pool.execute<{ tenant_id: string | null }>(sql`select app_merchant_tenant(${event.account}) as tenant_id`);
      if (row?.tenant_id) await runAsSystem(this.db, row.tenant_id, () => this.merchant.refresh());
    } else if (object?.object === 'payment_intent') {
      const [row] = await this.db.pool.execute<{ tenant_id: string | null }>(sql`select app_payment_tenant('stripe', ${object.id}) as tenant_id`);
      if (row?.tenant_id) await runAsSystem(this.db, row.tenant_id, () => this.sales.syncByProviderRef(object.id));
    }
    return { received: true };
  }

  /** Events from a business's own Stripe account, signed with the secret it gave us. */
  @Public()
  @Post('stripe/merchant/:tenantId')
  @HttpCode(200)
  async ownStripe(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Req() req: RawBodyRequest<Request>) {
    return runAsSystem(this.db, tenantId, async () => {
      const m = await this.cards.merchant();
      if (m?.mode !== 'own' || !m.ownWebhookSecret || !this.box) throw new NotFoundException();
      const event = verifyStripeWebhook(req.rawBody?.toString('utf8') ?? '', req.headers['stripe-signature'] as string | undefined, this.box.open<string>(m.ownWebhookSecret));
      if (!event) throw new BadRequestException('Invalid signature');
      if (event.data?.object?.object === 'payment_intent') await this.sales.syncByProviderRef(event.data.object.id);
      return { received: true };
    });
  }
}

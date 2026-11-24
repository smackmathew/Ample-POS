import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { SECRET_BOX, type SecretBox } from '../core/secrets';
import { CARD_PROVIDER, type CardPaymentProvider } from './provider';
import { SimulatedCardProvider } from './simulated.provider';
import { STRIPE_FETCH } from './connect';
import { StripeCardProvider } from './stripe.provider';

type Merchant = typeof schema.merchantAccounts.$inferSelect;
type Payment = typeof schema.payments.$inferSelect;

export type CardSetup = { provider: CardPaymentProvider } | { provider: null; code: 'not_set_up' | 'onboarding'; message: string };

/**
 * The card processor for the current business:
 * - its own Stripe account, when it connected one;
 * - its Express account under the platform (Stripe Connect), once Stripe lets it charge;
 * - the simulated processor in development (PAYMENTS_PROVIDER=simulated);
 * - otherwise none: card payments wait until the business sets them up, so
 *   money never lands in the platform's own account by accident. (STRIPE_ACCOUNT
 *   keeps the older single-account setup working.)
 */
@Injectable()
export class CardProviders {
  constructor(
    private readonly db: Db,
    @Inject(CARD_PROVIDER) private readonly platform: CardPaymentProvider,
    @Inject(SECRET_BOX) private readonly box: SecretBox | null,
    @Inject(STRIPE_FETCH) private readonly stripeFetch: typeof fetch,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get simulated(): boolean {
    return this.platform instanceof SimulatedCardProvider;
  }

  async merchant(): Promise<Merchant | null> {
    const [row] = await this.db.tx.select().from(schema.merchantAccounts);
    return row ?? null;
  }

  /** The processor new card payments go to. */
  async current(): Promise<CardSetup> {
    const m = await this.merchant();
    if (m?.mode === 'own') return { provider: this.own(m) };
    if (this.simulated) return { provider: this.platform };
    if (m?.mode === 'platform') {
      if (!m.chargesEnabled) return { provider: null, code: 'onboarding', message: 'Finish setting up card payments with Stripe (Settings → Card payments) to take cards.' };
      return { provider: (this.platform as StripeCardProvider).withAccount(m.connectAccountId!) };
    }
    if (this.config.STRIPE_ACCOUNT) return { provider: this.platform };
    return { provider: null, code: 'not_set_up', message: 'Card payments aren’t set up for this business yet. The owner can set them up in Card payments.' };
  }

  /** The processor an existing payment went through, so refunds and checks go back the same way. */
  async forPayment(payment: Pick<Payment, 'provider' | 'providerAccount'>): Promise<CardPaymentProvider> {
    if (payment.provider === 'simulated' || !payment.providerAccount) return this.platform;
    const m = await this.merchant();
    if (m?.ownAccountId === payment.providerAccount && m.ownSecretKey) return this.own(m);
    if (this.platform instanceof StripeCardProvider) return this.platform.withAccount(payment.providerAccount);
    return this.platform;
  }

  /** Decrypts the business's own key; only ever held in memory for the request. */
  private own(m: Merchant): StripeCardProvider {
    if (!this.box) throw new Error('SECRETS_KEY is needed to use a business’s own Stripe account');
    return new StripeCardProvider(this.box.open<string>(m.ownSecretKey!), { ownAccount: m.ownAccountId!, fetch: this.stripeFetch });
  }
}

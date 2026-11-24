import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { SECRET_BOX, type SecretBox } from '../core/secrets';
import { CardProviders } from './card-providers';
import { MERCHANT_CONNECT, type MerchantConnect, type MerchantStatus } from './connect';
import { ProviderUnavailableError } from './provider';
import { StripeApiError } from './stripe.provider';

type Merchant = typeof schema.merchantAccounts.$inferSelect;

/** Setting up and checking how the current business takes card payments. */
@Injectable()
export class MerchantService {
  constructor(
    private readonly db: Db,
    private readonly cards: CardProviders,
    private readonly events: Events,
    @Inject(MERCHANT_CONNECT) private readonly connect: MerchantConnect,
    @Inject(SECRET_BOX) private readonly box: SecretBox | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** What the business sees: never its keys. */
  async view() {
    const m = await this.cards.merchant();
    const setup = await this.cards.current();
    const { tenantId } = currentTenant();
    return {
      mode: m?.mode ?? 'off',
      ready: Boolean(setup.provider),
      message: setup.provider ? null : setup.message,
      simulated: this.cards.simulated,
      ownKeysSupported: Boolean(this.box),
      platform: m?.connectAccountId
        ? {
            accountId: m.connectAccountId,
            chargesEnabled: m.mode === 'platform' ? m.chargesEnabled : null,
            payoutsEnabled: m.mode === 'platform' ? m.payoutsEnabled : null,
            requirementsDue: m.mode === 'platform' ? m.requirementsDue : [],
            disabledReason: m.mode === 'platform' ? m.disabledReason : null,
          }
        : null,
      own: m?.ownAccountId
        ? { accountId: m.ownAccountId, businessName: m.mode === 'own' ? m.businessName : null, livemode: m.livemode, webhookConfigured: Boolean(m.ownWebhookSecret) }
        : null,
      ownWebhookUrl: `${this.apiUrl}/webhooks/stripe/merchant/${tenantId}`,
      statusSyncedAt: m?.statusSyncedAt ?? null,
    };
  }

  /** Starts (or continues) built-in onboarding: an Express account, then Stripe's hosted form. */
  async startPlatform(email: string | null): Promise<{ url: string }> {
    const { tenantId } = currentTenant();
    const m = await this.lock();
    const [tenant] = await this.db.tx.select({ name: schema.tenants.name }).from(schema.tenants);
    const accountId =
      m?.connectAccountId ?? (await this.guard(() => this.connect.createExpressAccount({ tenantId, email, businessName: tenant!.name, idempotencyKey: `express-${tenantId}` })));
    const status = await this.guard(() => this.connect.account(accountId));
    await this.save({ mode: 'platform', connectAccountId: accountId, ...this.statusFields(status) });
    await this.events.audit('payments.merchant_platform_started', { type: 'merchant', id: accountId });
    const page = `${this.config.WEB_URL}/b/${tenantId}/payments`;
    const url = await this.guard(() => this.connect.onboardingLink(accountId, { returnUrl: `${page}?onboarding=done`, refreshUrl: `${page}?onboarding=retry` }));
    return { url };
  }

  /** Connects the business's own Stripe account by its secret key. */
  async connectOwn(secretKey: string, webhookSecret: string | null) {
    if (!this.box) throw new ConflictException({ code: 'secrets_key_missing', message: 'Connecting your own Stripe account needs SECRETS_KEY set on the server' });
    await this.lock();
    const status = await this.guard(() => this.connect.ownAccount(secretKey), 'Stripe didn’t accept that key');
    await this.save({
      mode: 'own',
      ownAccountId: status.id,
      ownSecretKey: this.box.seal(secretKey),
      ownWebhookSecret: webhookSecret ? this.box.seal(webhookSecret) : null,
      ...this.statusFields(status),
    });
    await this.events.audit('payments.merchant_own_connected', { type: 'merchant', id: status.id }, { livemode: status.livemode });
    return this.view();
  }

  /** Re-reads the account in use from Stripe (after onboarding, and from webhooks). */
  async refresh() {
    const m = await this.lock();
    if (m?.mode === 'platform') await this.save(this.statusFields(await this.guard(() => this.connect.account(m.connectAccountId!))));
    else if (m?.mode === 'own' && this.box) await this.save(this.statusFields(await this.guard(() => this.connect.ownAccount(this.box!.open<string>(m.ownSecretKey!)))));
    return this.view();
  }

  async dashboardLink(): Promise<{ url: string }> {
    const m = await this.cards.merchant();
    if (m?.mode !== 'platform') throw new ConflictException('The Stripe dashboard link is for built-in card payments');
    return { url: await this.guard(() => this.connect.dashboardLink(m.connectAccountId!)) };
  }

  /** Stops card payments. Earlier payments can still be refunded; the setup is kept to turn back on. */
  async turnOff() {
    const m = await this.lock();
    if (m && m.mode !== 'off') {
      await this.save({ mode: 'off' });
      await this.events.audit('payments.merchant_off', { type: 'merchant', id: m.connectAccountId ?? m.ownAccountId ?? 'none' });
    }
    return this.view();
  }

  private get apiUrl(): string {
    return (this.config.PUBLIC_API_URL ?? `${this.config.WEB_URL}/api`).replace(/\/+$/, '');
  }

  private statusFields(s: MerchantStatus) {
    return {
      chargesEnabled: s.chargesEnabled,
      payoutsEnabled: s.payoutsEnabled,
      detailsSubmitted: s.detailsSubmitted,
      requirementsDue: s.requirementsDue,
      disabledReason: s.disabledReason,
      businessName: s.businessName,
      livemode: s.livemode,
      statusSyncedAt: new Date(),
    };
  }

  private async lock(): Promise<Merchant | null> {
    const [row] = await this.db.tx.select().from(schema.merchantAccounts).for('update');
    return row ?? null;
  }

  private async save(fields: Partial<typeof schema.merchantAccounts.$inferInsert>) {
    const { tenantId, membershipId: _m } = currentTenant();
    const values = { ...fields, updatedAt: new Date() };
    await this.db.tx
      .insert(schema.merchantAccounts)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({ target: schema.merchantAccounts.tenantId, set: values });
  }

  private async guard<T>(fn: () => Promise<T>, prefix?: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StripeApiError) throw new ConflictException({ code: 'stripe_error', message: prefix ? `${prefix}: ${err.message}` : err.message });
      if (err instanceof ProviderUnavailableError) throw new ConflictException({ code: 'stripe_unavailable', message: err.message });
      throw err;
    }
  }
}

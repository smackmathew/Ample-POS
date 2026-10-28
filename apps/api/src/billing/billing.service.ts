import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { schema, type BilledItem } from '@pos/db';
import { billableModules, MODULES } from '@pos/modules';
import { count, eq, isNull } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentContext, currentTenant } from '../core/request-context';
import { ProviderUnavailableError } from '../payments/provider';
import { StripeApiError } from '../payments/stripe.provider';
import { enabledModuleIds } from '../platform/modules.controller';
import { BILLING_PROVIDER, OPEN_STATUSES, sameItems, type BillingProvider, type ProviderSubscription } from './provider';
import { standing } from './standing';

type BillingRow = typeof schema.tenantBilling.$inferSelect;

/** Stripe needs a trial carried into Checkout to end at least two days out. */
const MIN_TRIAL_CARRY_MS = 48 * 3_600_000;

/** Billing for the current business. Works in request and system (webhook, worker) transactions. */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async row(lock = false): Promise<BillingRow> {
    const query = this.db.tx.select().from(schema.tenantBilling);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException('Billing is not set up for this business');
    return row;
  }

  /** Each enabled paid tool, billed once per active location (at least one). */
  async desiredItems(): Promise<BilledItem[]> {
    const [{ locations }] = (await this.db.tx.select({ locations: count() }).from(schema.locations).where(isNull(schema.locations.archivedAt))) as [
      { locations: number },
    ];
    const quantity = Math.max(1, Number(locations));
    return billableModules(await enabledModuleIds(this.db)).map((m) => ({ moduleId: m.id, quantity }));
  }

  async summary() {
    const row = await this.row();
    const items = await this.desiredItems();
    const enabled = await enabledModuleIds(this.db);
    const subscribed = row.status !== null && OPEN_STATUSES.has(row.status);
    return {
      standing: standing(row),
      trialEndsAt: row.trialEndsAt,
      provider: this.provider.name,
      canManageOnline: Boolean(this.provider.portalUrl) && row.provider === this.provider.name && Boolean(row.customerId),
      subscription: subscribed
        ? { status: row.status, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd, syncedAt: row.syncedAt }
        : null,
      // What the next bill is based on, from the tools that are on right now.
      lines: items.map((i) => {
        const mod = MODULES.find((m) => m.id === i.moduleId)!;
        return { moduleId: i.moduleId, name: mod.name, unitMinor: mod.monthlyPriceMinor, quantity: i.quantity, totalMinor: mod.monthlyPriceMinor * i.quantity };
      }),
      included: MODULES.filter((m) => enabled.has(m.id) && m.monthlyPriceMinor === 0).map((m) => m.name),
      monthlyTotalMinor: items.reduce((t, i) => t + MODULES.find((m) => m.id === i.moduleId)!.monthlyPriceMinor * i.quantity, 0),
      currency: 'usd',
    };
  }

  /** Starts a subscription for the tools that are on. Returns where to send the owner, if anywhere. */
  async checkout(): Promise<{ url: string } | { subscribed: true }> {
    const { tenantId } = currentTenant();
    const row = await this.row(true);
    if (row.provider === this.provider.name && row.status && OPEN_STATUSES.has(row.status)) {
      throw new ConflictException({ code: 'already_subscribed', message: 'This business already has a subscription' });
    }
    const customerId = await this.ensureCustomer(row);
    // Carry the rest of the free trial into the subscription, but only for a first subscription.
    const trialLeft = row.trialEndsAt.getTime() - Date.now();
    const trialEnd = !row.subscriptionId && trialLeft >= MIN_TRIAL_CARRY_MS ? row.trialEndsAt : null;
    const page = `${this.config.WEB_URL}/b/${tenantId}/billing`;
    const items = await this.desiredItems();
    const result = await this.guard(() =>
      this.provider.startCheckout({
        tenantId,
        customerId,
        items,
        trialEnd,
        successUrl: `${page}?checkout=success`,
        cancelUrl: `${page}?checkout=canceled`,
      }),
    );
    if ('url' in result) return result;
    await this.save(result.subscription);
    return { subscribed: true };
  }

  /** Re-reads the subscription from the provider (after checkout, and on webhooks). */
  async refresh(): Promise<void> {
    const row = await this.row(true);
    if (!row.customerId || row.provider !== this.provider.name || !this.provider.currentSubscription) return;
    const sub = await this.guard(() => this.provider.currentSubscription!(row.customerId!));
    await this.save(sub, row);
  }

  /** Brings the subscription's items in line with the tools and locations in use. */
  async syncItems(): Promise<boolean> {
    const row = await this.row(true);
    if (!row.subscriptionId || !row.status || !OPEN_STATUSES.has(row.status) || row.provider !== this.provider.name) return false;
    const desired = await this.desiredItems();
    if (sameItems(row.items, desired)) return false;
    const key = createHash('sha256').update(`${row.subscriptionId}:${JSON.stringify([...desired].sort((a, b) => a.moduleId.localeCompare(b.moduleId)))}:${row.updatedAt.toISOString()}`).digest('hex');
    const updated = await this.guard(() => this.provider.updateItems(this.asSubscription(row), desired, `items-${key}`));
    await this.save(updated, row);
    return true;
  }

  async setCancelAtPeriodEnd(cancel: boolean) {
    const row = await this.row(true);
    if (!row.subscriptionId || !row.status || !OPEN_STATUSES.has(row.status) || row.provider !== this.provider.name) {
      throw new ConflictException({ code: 'not_subscribed', message: 'This business has no subscription' });
    }
    const updated = await this.guard(() => this.provider.setCancelAtPeriodEnd(this.asSubscription(row), cancel));
    await this.save(updated, row);
    await this.events.audit(cancel ? 'billing.cancel_requested' : 'billing.resumed', { type: 'subscription', id: row.subscriptionId });
  }

  async portalUrl(): Promise<string> {
    const row = await this.row();
    if (!this.provider.portalUrl || row.provider !== this.provider.name || !row.customerId) {
      throw new ConflictException({ code: 'no_portal', message: 'Online billing management is not available' });
    }
    const { tenantId } = currentTenant();
    return this.guard(() => this.provider.portalUrl!(row.customerId!, `${this.config.WEB_URL}/b/${tenantId}/billing`));
  }

  private async ensureCustomer(row: BillingRow): Promise<string> {
    // A customer from another provider (e.g. simulated in development) is not reused.
    if (row.customerId && row.provider === this.provider.name) return row.customerId;
    const { tenantId } = currentTenant();
    const [tenant] = await this.db.tx.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    const user = currentContext().user;
    const [me] = user ? await this.db.tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, user.userId)) : [];
    const customerId = await this.guard(() => this.provider.createCustomer({ tenantId, name: tenant!.name, email: me?.email ?? null }));
    await this.db.tx
      .update(schema.tenantBilling)
      .set({ provider: this.provider.name, customerId, subscriptionId: null, status: null, items: [], currentPeriodEnd: null, cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(eq(schema.tenantBilling.tenantId, tenantId));
    return customerId;
  }

  private async save(sub: ProviderSubscription | null, before?: BillingRow): Promise<void> {
    const prev = before ?? (await this.row());
    const { tenantId } = currentTenant();
    await this.db.tx
      .update(schema.tenantBilling)
      .set({
        provider: this.provider.name,
        subscriptionId: sub?.id ?? prev.subscriptionId,
        status: sub?.status ?? null,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
        items: sub?.items ?? [],
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.tenantBilling.tenantId, tenantId));
    const status = sub?.status ?? null;
    if (status !== prev.status) {
      // Other work (syncing items after checkout) follows from this event.
      await this.events.record('billing.status_changed', { type: 'subscription', id: sub?.id ?? prev.subscriptionId ?? tenantId }, { from: prev.status, to: status });
    }
  }

  private asSubscription(row: BillingRow): ProviderSubscription {
    return { id: row.subscriptionId!, status: row.status!, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd, items: row.items };
  }

  /** Provider outages become 503s; provider rejections become 409s with Stripe's message. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw new ServiceUnavailableException(err.message);
      if (err instanceof StripeApiError) throw new ConflictException({ code: 'billing_provider_error', message: err.message });
      throw err;
    }
  }
}

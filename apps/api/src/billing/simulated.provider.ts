import { randomUUID } from 'node:crypto';
import type { BilledItem } from '@pos/db';
import type { BillingProvider, CheckoutInput, ProviderSubscription } from './provider';

const MONTH_MS = 30 * 86_400_000;

/**
 * Billing without a payment processor, for development and demos: checkout
 * subscribes immediately and every change succeeds. Our tenant_billing row is
 * the only record, so nothing is kept here.
 */
export class SimulatedBillingProvider implements BillingProvider {
  readonly name = 'simulated';

  async createCustomer(): Promise<string> {
    return `sim_cus_${randomUUID()}`;
  }

  async startCheckout(input: CheckoutInput) {
    const start = input.trialEnd ?? new Date();
    const subscription: ProviderSubscription = {
      id: `sim_sub_${randomUUID()}`,
      status: input.trialEnd ? 'trialing' : 'active',
      currentPeriodEnd: input.trialEnd ?? new Date(start.getTime() + MONTH_MS),
      cancelAtPeriodEnd: false,
      items: input.items,
    };
    return { subscription };
  }

  async updateItems(subscription: ProviderSubscription, items: BilledItem[]) {
    return { ...subscription, items };
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscription, cancel: boolean) {
    return { ...subscription, cancelAtPeriodEnd: cancel };
  }
}

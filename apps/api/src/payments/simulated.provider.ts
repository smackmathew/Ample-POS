import { randomUUID } from 'node:crypto';
import type { CardPaymentProvider, ProviderPayment, ProviderRefund } from './provider';

interface SimPayment {
  amountMinor: number;
  status: ProviderPayment['status'];
  error: string | null;
  refunded: number;
}

/**
 * In-memory stand-in for a card processor, for development and tests.
 * Like a real reader, a payment stays pending until a card is presented:
 * call `present(ref, 'approve' | 'decline')` to simulate the customer tapping.
 * State lives in this process only.
 */
export class SimulatedCardProvider implements CardPaymentProvider {
  readonly name = 'simulated';
  private readonly payments = new Map<string, SimPayment>();
  private readonly refunds = new Map<string, ProviderRefund>();

  async createCardPayment(input: { amountMinor: number; idempotencyKey: string }): Promise<ProviderPayment> {
    const ref = `sim_pi_${input.idempotencyKey}`;
    if (!this.payments.has(ref)) this.payments.set(ref, { amountMinor: input.amountMinor, status: 'pending', error: null, refunded: 0 });
    return this.view(ref);
  }

  async retrieve(ref: string): Promise<ProviderPayment> {
    return this.view(ref);
  }

  async cancel(ref: string): Promise<ProviderPayment> {
    const p = this.get(ref);
    if (p.status === 'pending') p.status = 'canceled';
    return this.view(ref);
  }

  /** Simulates the customer presenting a card at the reader. */
  present(ref: string, outcome: 'approve' | 'decline'): ProviderPayment {
    const p = this.get(ref);
    if (p.status !== 'pending') return this.view(ref);
    if (outcome === 'approve') {
      p.status = 'succeeded';
      p.error = null;
    } else {
      p.error = 'Your card was declined.';
    }
    return this.view(ref);
  }

  async refund(input: { ref: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund> {
    const existing = this.refunds.get(input.idempotencyKey);
    if (existing) return existing;
    const p = this.get(input.ref);
    const refund: ProviderRefund =
      p.status === 'succeeded' && p.refunded + input.amountMinor <= p.amountMinor
        ? { ref: `sim_re_${randomUUID()}`, status: 'succeeded', error: null }
        : { ref: `sim_re_${randomUUID()}`, status: 'failed', error: 'Amount exceeds the refundable balance' };
    if (refund.status === 'succeeded') p.refunded += input.amountMinor;
    this.refunds.set(input.idempotencyKey, refund);
    return refund;
  }

  private get(ref: string): SimPayment {
    const p = this.payments.get(ref);
    if (!p) throw new Error(`Unknown simulated payment ${ref}`);
    return p;
  }

  private view(ref: string): ProviderPayment {
    const p = this.get(ref);
    return { ref, status: p.status, clientSecret: `${ref}_secret`, error: p.error };
  }
}

import type { LocationAddress } from '@pos/db';

/**
 * A card payment processor. Implementations must make create and refund
 * idempotent on `idempotencyKey`, so a retried request after a timeout never
 * charges or refunds twice.
 */
export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'canceled';

export interface ProviderPayment {
  ref: string;
  status: ProviderPaymentStatus;
  /** Handed to the card reader SDK to collect the card. */
  clientSecret: string | null;
  /** Latest decline or error, e.g. "Your card was declined." The payment stays pending and can be retried. */
  error: string | null;
}

export interface ProviderRefund {
  ref: string;
  status: 'pending' | 'succeeded' | 'failed';
  error: string | null;
}

/** Readers driven by an SDK on the register itself (Stripe Terminal), rather than by the server. */
export interface TerminalReaders {
  /** Short-lived token the register's SDK uses to talk to the processor, scoped to one store. */
  connectionToken(locationRef: string): Promise<string>;
  /** Creates (ref null) or updates the processor's record of a store; returns its ref. */
  saveLocation(input: { ref: string | null; displayName: string; address: LocationAddress; idempotencyKey: string }): Promise<string>;
}

export interface CardPaymentProvider {
  readonly name: string;
  /** Present when card readers connect from the register app. Absent for the simulated processor. */
  readonly terminal?: TerminalReaders;
  createCardPayment(input: {
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderPayment>;
  retrieve(ref: string): Promise<ProviderPayment>;
  cancel(ref: string): Promise<ProviderPayment>;
  refund(input: { ref: string; amountMinor: number; idempotencyKey: string }): Promise<ProviderRefund>;
}

/** The provider could not be reached or answered with an error we can't act on. */
export class ProviderUnavailableError extends Error {}

export const CARD_PROVIDER = Symbol('CARD_PROVIDER');

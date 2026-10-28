import { ApiError, NetworkError, type ApiClient } from './api-client';
import { variantLabel, type CatalogVariant } from './catalog';

// Cart ---------------------------------------------------------------------------

export interface CartLine {
  variantId: string;
  label: string;
  unitMinor: number;
  quantity: number;
}

/**
 * The register's cart. Prices here are for display while ringing up; the
 * server prices the sale (tax, rounding) when it is created.
 */
export class Cart {
  private constructor(readonly lines: readonly CartLine[]) {}

  static empty(): Cart {
    return new Cart([]);
  }

  /** Scanning the same item again adds one more of it. */
  add(v: CatalogVariant, quantity = 1): Cart {
    const existing = this.lines.find((l) => l.variantId === v.id);
    if (existing) return this.setQuantity(v.id, existing.quantity + quantity);
    return new Cart([...this.lines, { variantId: v.id, label: variantLabel(v), unitMinor: v.priceMinor, quantity }]);
  }

  /** Zero or less removes the line. */
  setQuantity(variantId: string, quantity: number): Cart {
    const q = Math.min(10_000, Math.floor(quantity));
    return new Cart(q > 0 ? this.lines.map((l) => (l.variantId === variantId ? { ...l, quantity: q } : l)) : this.lines.filter((l) => l.variantId !== variantId));
  }

  get itemCount(): number {
    return this.lines.reduce((n, l) => n + l.quantity, 0);
  }

  /** Before tax and discounts. */
  get subtotalMinor(): number {
    return this.lines.reduce((t, l) => t + l.unitMinor * l.quantity, 0);
  }
}

// Server shapes ------------------------------------------------------------------

export interface RegisterSession {
  id: string;
  locationId: string;
  status: 'open' | 'closed';
  openingFloatMinor: number;
  openedAt: string;
}

export interface RegisterSummary extends RegisterSession {
  locationName: string;
  countedCashMinor: number | null;
  totals: { salesCount: number; grossMinor: number; cashMinor: number; cardMinor: number; cashRefundsMinor: number; expectedCashMinor: number | null };
  /** Counted minus expected, once closed. */
  varianceMinor: number | null;
}

export interface SalePayment {
  id: string;
  method: 'cash' | 'card';
  status: 'pending' | 'succeeded' | 'canceled' | 'failed';
  amountMinor: number;
  tenderedMinor: number | null;
  changeMinor: number | null;
  lastError: string | null;
}

export interface Sale {
  id: string;
  status: 'open' | 'completed' | 'voided';
  receiptNumber: number | null;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  pendingMinor: number;
  dueMinor: number;
  lines: { id: string; description: string; quantity: number; unitPriceMinor: number; totalMinor: number }[];
  payments: SalePayment[];
}

interface PaymentResponse {
  payment: SalePayment;
  clientSecret: string | null;
  sale: Sale;
}

export interface TerminalConfig {
  provider: string;
  /** sdk: a real reader through the processor's SDK. simulated: approve/decline buttons. */
  readers: 'sdk' | 'simulated';
  location: { ready: boolean; problem: string | null };
}

// Card readers -------------------------------------------------------------------

export type CollectResult = { status: 'approved' } | { status: 'declined' | 'canceled' | 'error'; message: string };

/**
 * A card reader driven from the register (Stripe Terminal's SDK in the app).
 * `collect` reads the card and authorizes the payment the server created.
 */
export interface CardReader {
  collect(clientSecret: string): Promise<CollectResult>;
  /** Stops waiting for a card, if the reader allows it at this point. */
  cancelCollect(): Promise<void>;
}

export type CardOutcome =
  | { status: 'paid'; sale: Sale }
  /** The card didn't go through; the payment stays open, so try again or pay another way. */
  | { status: 'retry'; sale: Sale; paymentId: string; message: string }
  | { status: 'canceled'; sale: Sale };

/**
 * Runs a sale from cart to paid. Every request carries an id made on the
 * register, so a retry after a dropped connection never creates a second sale
 * or charges a card twice.
 */
export class Checkout {
  constructor(
    private readonly api: ApiClient,
    private readonly newId: () => string,
  ) {}

  currentRegister(): Promise<{ session: RegisterSession | null; paymentsProvider: string }> {
    return this.api.get('/registers/sessions/current');
  }

  openRegister(locationId: string, openingFloatMinor: number): Promise<RegisterSession> {
    return this.api.post('/registers/sessions', { locationId, openingFloatMinor });
  }

  registerSummary(sessionId: string): Promise<RegisterSummary> {
    return this.api.get(`/registers/sessions/${sessionId}`);
  }

  closeRegister(sessionId: string, countedCashMinor: number): Promise<RegisterSummary> {
    return this.api.post(`/registers/sessions/${sessionId}/close`, { countedCashMinor });
  }

  terminalConfig(): Promise<TerminalConfig> {
    return this.api.get('/terminal/config');
  }

  /** `saleId` should be made once per cart and reused if the request is retried. */
  createSale(saleId: string, registerSessionId: string, cart: Cart): Promise<Sale> {
    return this.api.post('/sales', {
      id: saleId,
      registerSessionId,
      lines: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    });
  }

  getSale(saleId: string): Promise<Sale> {
    return this.api.get(`/sales/${saleId}`);
  }

  voidSale(saleId: string): Promise<Sale> {
    return this.api.post(`/sales/${saleId}/void`);
  }

  async payCash(saleId: string, tenderedMinor: number, paymentId = this.newId()): Promise<{ sale: Sale; changeMinor: number }> {
    const res = await this.api.post<PaymentResponse>(`/sales/${saleId}/payments`, { id: paymentId, method: 'cash', tenderedMinor });
    return { sale: res.sale, changeMinor: res.payment.changeMinor ?? 0 };
  }

  /** Starts (or, with the same `paymentId`, resumes) a card payment for what's due. */
  startCard(saleId: string, paymentId: string): Promise<PaymentResponse> {
    return this.api.post(`/sales/${saleId}/payments`, { id: paymentId, method: 'card' });
  }

  /**
   * Card payment on a reader. The reader's answer is never taken as final: the
   * server re-reads the payment from the processor before the sale is marked paid.
   */
  async payCard(saleId: string, reader: CardReader, paymentId = this.newId()): Promise<CardOutcome> {
    const started = await this.startCard(saleId, paymentId);
    if (started.payment.status === 'succeeded') return { status: 'paid', sale: started.sale };
    if (!started.clientSecret) return this.settle(saleId, paymentId, 'The payment could not be started on the reader');

    const result = await reader.collect(started.clientSecret);
    if (result.status === 'canceled') {
      // The customer or cashier stopped; release the payment so the sale can be paid another way.
      return { status: 'canceled', sale: await this.cancelCard(saleId, paymentId) };
    }
    return this.settle(saleId, paymentId, result.status === 'approved' ? null : result.message);
  }

  /** Test processor only: stands in for the customer tapping a card. */
  async simulateCard(saleId: string, outcome: 'approve' | 'decline', paymentId = this.newId()): Promise<CardOutcome> {
    const started = await this.startCard(saleId, paymentId);
    if (started.payment.status === 'succeeded') return { status: 'paid', sale: started.sale };
    await this.api.post(`/sales/${saleId}/payments/${paymentId}/simulate`, { outcome });
    return this.settle(saleId, paymentId, outcome === 'decline' ? 'Card declined' : null);
  }

  async cancelCard(saleId: string, paymentId: string): Promise<Sale> {
    try {
      return await this.api.post<Sale>(`/sales/${saleId}/payments/${paymentId}/cancel`);
    } catch (err) {
      // It went through after all (e.g. the customer tapped just as we canceled).
      const sale = (err instanceof ApiError && err.status === 409 ? (err.body as { sale?: Sale } | undefined)?.sale : undefined) ?? null;
      if (sale) return sale;
      throw err;
    }
  }

  /** Asks the server for the payment's real state and turns it into an outcome. */
  private async settle(saleId: string, paymentId: string, readerMessage: string | null): Promise<CardOutcome> {
    const sale = await this.syncWithRetry(saleId, paymentId);
    const payment = sale.payments.find((p) => p.id === paymentId);
    if (sale.status === 'completed' || payment?.status === 'succeeded') return { status: 'paid', sale };
    if (payment?.status === 'canceled' || payment?.status === 'failed') return { status: 'canceled', sale };
    return { status: 'retry', sale, paymentId, message: payment?.lastError ?? readerMessage ?? 'The card was not charged. Try again or use another card.' };
  }

  /** A dropped connection right after a tap shouldn't leave the cashier guessing. */
  private async syncWithRetry(saleId: string, paymentId: string, attempts = 3): Promise<Sale> {
    for (let i = 1; ; i++) {
      try {
        return await this.api.post<Sale>(`/sales/${saleId}/payments/${paymentId}/sync`);
      } catch (err) {
        if (!(err instanceof NetworkError) || i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }
}

/** Notes and coins to suggest for cash: exact, then the next round amounts up. */
export function quickCashAmounts(dueMinor: number): number[] {
  const steps = [100, 500, 1000, 2000, 5000, 10_000];
  const out = new Set<number>([dueMinor]);
  for (const step of steps) {
    const up = Math.ceil(dueMinor / step) * step;
    if (up > dueMinor) out.add(up);
    if (out.size >= 4) break;
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses "12", "12.5" or "$1,012.50" into cents without floating point. Null if invalid. */
export function parseMoney(input: string): number | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input.replace(/[$,]/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function formatMoney(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

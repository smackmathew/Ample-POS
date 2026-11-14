import type { ApiClient } from './api-client';

export type PurchaseOrderStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'canceled';

export interface PurchaseOrderSummary {
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  supplierName: string;
  locationId: string;
  locationName: string;
  expectedOn: string | null;
  orderedAt: string | null;
  itemCount: number;
}

export interface PurchaseOrderLine {
  id: string;
  variantId: string;
  description: string;
  sku: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  unitCostMinor: number;
  onHand: number;
}

export interface PurchaseOrder {
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  locationId: string;
  locationName: string;
  supplier: { id: string; name: string };
  expectedOn: string | null;
  note: string | null;
  lines: PurchaseOrderLine[];
}

/**
 * What has arrived in this delivery, counted by scanning or tapping, before
 * it is sent. Immutable: every change returns a new tally.
 */
export class ReceivingTally {
  private constructor(
    readonly lines: readonly PurchaseOrderLine[],
    private readonly counts: ReadonlyMap<string, number>,
  ) {}

  static for(order: Pick<PurchaseOrder, 'lines'>): ReceivingTally {
    return new ReceivingTally(order.lines, new Map());
  }

  /** The order's line for a scanned item, if it's on the order. */
  lineFor(variantId: string): PurchaseOrderLine | null {
    return this.lines.find((l) => l.variantId === variantId) ?? null;
  }

  arrived(lineId: string): number {
    return this.counts.get(lineId) ?? 0;
  }

  /** Still expected after this delivery (never below zero: extra units are fine). */
  outstanding(line: PurchaseOrderLine): number {
    return Math.max(0, line.quantityOrdered - line.quantityReceived - this.arrived(line.id));
  }

  add(lineId: string, by = 1): ReceivingTally {
    if (!this.lines.some((l) => l.id === lineId)) throw new RangeError('That item isn’t on this order');
    return this.set(lineId, this.arrived(lineId) + by);
  }

  set(lineId: string, quantity: number): ReceivingTally {
    const next = new Map(this.counts);
    const q = Math.max(0, Math.min(1_000_000, Math.floor(quantity)));
    if (q === 0) next.delete(lineId);
    else next.set(lineId, q);
    return new ReceivingTally(this.lines, next);
  }

  /** Everything still expected has arrived. */
  fillAll(): ReceivingTally {
    let tally: ReceivingTally = new ReceivingTally(this.lines, new Map());
    for (const l of this.lines) tally = tally.set(l.id, Math.max(0, l.quantityOrdered - l.quantityReceived));
    return tally;
  }

  get units(): number {
    let n = 0;
    for (const q of this.counts.values()) n += q;
    return n;
  }

  /** The request body's lines: only items that arrived. */
  toLines(): { lineId: string; quantity: number }[] {
    return this.lines.filter((l) => this.arrived(l.id) > 0).map((l) => ({ lineId: l.id, quantity: this.arrived(l.id) }));
  }
}

/** Purchase orders from the device: open orders for its location, and receiving them. */
export class Receiving {
  constructor(
    private readonly api: ApiClient,
    private readonly newId: () => string,
  ) {}

  /** Purchase orders are on and the signed-in person may receive. */
  async available(): Promise<boolean> {
    const t = await this.api.get<{ enabledModules: string[]; membership: { permissions: string[] } }>('/tenant');
    const p = t.membership.permissions;
    return t.enabledModules.includes('purchasing') && (p.includes('*') || p.includes('purchasing.receive'));
  }

  /** Placed orders still waiting for stock at this location. */
  async openOrders(locationId: string): Promise<PurchaseOrderSummary[]> {
    const orders = await this.api.get<PurchaseOrderSummary[]>(`/purchase-orders?status=open&locationId=${locationId}`);
    return orders.filter((o) => o.status === 'ordered' || o.status === 'partially_received');
  }

  order(id: string): Promise<PurchaseOrder> {
    return this.api.get(`/purchase-orders/${id}`);
  }

  /** A fresh id for the next delivery; reuse it when retrying the same one. */
  deliveryId(): string {
    return this.newId();
  }

  receive(orderId: string, deliveryId: string, tally: ReceivingTally, options: { updateCosts?: boolean; note?: string } = {}): Promise<PurchaseOrder> {
    return this.api.post(`/purchase-orders/${orderId}/receive`, {
      id: deliveryId,
      lines: tally.toLines(),
      updateCosts: options.updateCosts ?? true,
      note: options.note || undefined,
    });
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { schema, type PurchaseOrderStatus } from '@pos/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { LedgerService } from '../inventory/ledger.service';

export interface DraftLine {
  variantId: string;
  quantity: number;
  unitCostMinor: number;
}

export interface DraftInput {
  supplierId: string;
  locationId: string;
  note?: string | null;
  expectedOn?: string | null;
  lines: DraftLine[];
}

export interface ReceiveInput {
  /** Made by the client, so a retry never adds stock twice. */
  id: string;
  lines: { lineId: string; quantity: number }[];
  /** Set each item's cost to what this order paid. */
  updateCosts: boolean;
  note?: string | null;
}

type Order = typeof schema.purchaseOrders.$inferSelect;

const OPEN: PurchaseOrderStatus[] = ['ordered', 'partially_received'];

/** Purchase orders: drafting, ordering and receiving into stock. */
@Injectable()
export class PurchasingService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly events: Events,
  ) {}

  async create(input: DraftInput) {
    await this.checkDraft(input);
    const tenantId = currentTenant().tenantId;
    const [counter] = await this.db.tx
      .insert(schema.tenantCounters)
      .values({ tenantId, name: 'purchase_order', value: 1 })
      .onConflictDoUpdate({ target: [schema.tenantCounters.tenantId, schema.tenantCounters.name], set: { value: sql`${schema.tenantCounters.value} + 1` } })
      .returning({ value: schema.tenantCounters.value });
    const [order] = await this.db.tx
      .insert(schema.purchaseOrders)
      .values({
        tenantId,
        number: counter!.value,
        supplierId: input.supplierId,
        locationId: input.locationId,
        note: input.note ?? null,
        expectedOn: input.expectedOn ?? null,
        createdBy: currentUserId(),
      })
      .returning();
    await this.writeLines(order!.id, input.lines);
    await this.events.audit('purchase_order.created', { type: 'purchase_order', id: order!.id }, { number: order!.number });
    return this.get(order!.id);
  }

  /** Replaces a draft's details and lines. */
  async update(id: string, input: DraftInput) {
    const order = await this.lock(id);
    if (order.status !== 'draft') throw new ConflictException('Only draft orders can be edited');
    await this.checkDraft(input);
    await this.db.tx
      .update(schema.purchaseOrders)
      .set({ supplierId: input.supplierId, locationId: input.locationId, note: input.note ?? null, expectedOn: input.expectedOn ?? null, updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, id));
    await this.db.tx.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    await this.writeLines(id, input.lines);
    return this.get(id);
  }

  /** Marks a draft as ordered (sent to the supplier). */
  async markOrdered(id: string) {
    const order = await this.lock(id);
    if (order.status !== 'draft') throw new ConflictException('This order was already placed');
    const lines = await this.db.tx.select({ id: schema.purchaseOrderLines.id }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    if (!lines.length) throw new BadRequestException('Add at least one item before ordering');
    await this.db.tx.update(schema.purchaseOrders).set({ status: 'ordered', orderedAt: new Date(), updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, id));
    await this.events.record('purchase_order.ordered', { type: 'purchase_order', id }, { number: order.number });
  }

  /** Records a delivery: stock goes in at the order's location. */
  async receive(id: string, input: ReceiveInput) {
    const [existing] = await this.db.tx.select().from(schema.purchaseOrderReceipts).where(eq(schema.purchaseOrderReceipts.id, input.id));
    if (existing) {
      if (existing.purchaseOrderId !== id) throw new ConflictException('Receipt id already used for another order');
      return this.get(id);
    }
    const order = await this.lock(id);
    if (!OPEN.includes(order.status)) {
      throw new ConflictException(order.status === 'draft' ? 'Place the order before receiving it' : `This order is ${order.status.replace('_', ' ')}`);
    }
    const lines = await this.db.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const byId = new Map(lines.map((l) => [l.id, l]));
    const received = input.lines.filter((l) => l.quantity > 0);
    if (!received.length) throw new BadRequestException('Enter how many of at least one item arrived');
    if (new Set(received.map((l) => l.lineId)).size !== received.length) throw new BadRequestException('Each item may appear once');
    for (const r of received) if (!byId.has(r.lineId)) throw new NotFoundException('That item isn’t on this order');

    const operation = await this.ledger.record({
      kind: 'receipt',
      idempotencyKey: `po-receipt:${input.id}`,
      note: input.note ?? `PO-${order.number}`,
      reference: { type: 'purchase_order', id },
      lines: received.map((r) => ({ locationId: order.locationId, variantId: byId.get(r.lineId)!.variantId, quantityDelta: r.quantity, reason: 'receive' })),
    });
    await this.db.tx.insert(schema.purchaseOrderReceipts).values({
      id: input.id,
      tenantId: order.tenantId,
      purchaseOrderId: id,
      inventoryOperationId: operation.operationId,
      note: input.note ?? null,
      createdBy: currentUserId(),
    });
    await this.db.tx.insert(schema.purchaseOrderReceiptLines).values(received.map((r) => ({ tenantId: order.tenantId, receiptId: input.id, lineId: r.lineId, quantity: r.quantity })));
    for (const r of received) {
      await this.db.tx
        .update(schema.purchaseOrderLines)
        .set({ quantityReceived: sql`${schema.purchaseOrderLines.quantityReceived} + ${r.quantity}` })
        .where(eq(schema.purchaseOrderLines.id, r.lineId));
      if (input.updateCosts) {
        await this.db.tx
          .update(schema.productVariants)
          .set({ costMinor: byId.get(r.lineId)!.unitCostMinor, updatedAt: new Date() })
          .where(eq(schema.productVariants.id, byId.get(r.lineId)!.variantId));
      }
    }
    // Everything ordered has arrived (extra is fine): the order is done.
    const after = await this.db.tx.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchaseOrderId, id));
    const complete = after.every((l) => l.quantityReceived >= l.quantityOrdered);
    await this.db.tx
      .update(schema.purchaseOrders)
      .set({ status: complete ? 'received' : 'partially_received', closedAt: complete ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, id));
    await this.events.record('purchase_order.received', { type: 'purchase_order', id }, {
      receiptId: input.id,
      complete,
      lines: received.map((r) => ({ variantId: byId.get(r.lineId)!.variantId, quantity: r.quantity })),
    });
    return this.get(id);
  }

  /** Done with an order that won't arrive in full: nothing more is expected. */
  async close(id: string) {
    const order = await this.lock(id);
    if (order.status !== 'partially_received') throw new ConflictException('Only partly received orders can be closed. Cancel an order nothing arrived for.');
    await this.db.tx.update(schema.purchaseOrders).set({ status: 'received', closedAt: new Date(), updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, id));
    await this.events.audit('purchase_order.closed', { type: 'purchase_order', id });
    return this.get(id);
  }

  async cancel(id: string) {
    const order = await this.lock(id);
    if (order.status === 'canceled') return this.get(id);
    if (order.status !== 'draft' && order.status !== 'ordered') throw new ConflictException('Part of this order already arrived. Close it instead.');
    await this.db.tx.update(schema.purchaseOrders).set({ status: 'canceled', closedAt: new Date(), updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, id));
    await this.events.audit('purchase_order.canceled', { type: 'purchase_order', id });
    return this.get(id);
  }

  async get(id: string) {
    const po = schema.purchaseOrders;
    const [row] = await this.db.tx
      .select({ order: po, supplier: schema.suppliers, locationName: schema.locations.name })
      .from(po)
      .innerJoin(schema.suppliers, eq(schema.suppliers.id, po.supplierId))
      .innerJoin(schema.locations, eq(schema.locations.id, po.locationId))
      .where(eq(po.id, id));
    if (!row) throw new NotFoundException('Purchase order not found');
    const l = schema.purchaseOrderLines;
    const lines = await this.db.tx
      .select({
        id: l.id,
        variantId: l.variantId,
        productName: schema.products.name,
        variantName: schema.productVariants.name,
        sku: schema.productVariants.sku,
        quantityOrdered: l.quantityOrdered,
        quantityReceived: l.quantityReceived,
        unitCostMinor: l.unitCostMinor,
        onHand: sql<number>`coalesce((select on_hand from stock_levels sl where sl.variant_id = ${l.variantId} and sl.location_id = ${row.order.locationId}), 0)`.mapWith(Number),
      })
      .from(l)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, l.variantId))
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(l.purchaseOrderId, id))
      .orderBy(asc(l.position));
    const r = schema.purchaseOrderReceipts;
    const receipts = await this.db.tx
      .select({
        id: r.id,
        note: r.note,
        createdAt: r.createdAt,
        receivedBy: schema.users.displayName,
        units: sql<number>`(select coalesce(sum(quantity), 0) from purchase_order_receipt_lines rl where rl.receipt_id = ${r.id})`.mapWith(Number),
      })
      .from(r)
      .leftJoin(schema.users, eq(schema.users.id, r.createdBy))
      .where(eq(r.purchaseOrderId, id))
      .orderBy(desc(r.createdAt));
    const { supplier } = row;
    return {
      ...row.order,
      reference: `PO-${row.order.number}`,
      supplier: { id: supplier.id, name: supplier.name, email: supplier.email, contactName: supplier.contactName, phone: supplier.phone },
      locationName: row.locationName,
      lines: lines.map(({ productName, variantName, ...line }) => ({ ...line, description: variantName === 'Default' ? productName : `${productName} — ${variantName}` })),
      totalMinor: lines.reduce((n, x) => n + x.unitCostMinor * x.quantityOrdered, 0),
      receipts,
    };
  }

  /**
   * Items to order for a location: tracked items with at most `atOrBelow` on
   * hand, not already on an open order there, with their last cost.
   */
  async lowStock(locationId: string, atOrBelow: number) {
    const v = schema.productVariants;
    const rows = await this.db.tx
      .select({
        variantId: v.id,
        productName: schema.products.name,
        variantName: v.name,
        sku: v.sku,
        costMinor: v.costMinor,
        onHand: sql<number>`coalesce(sl.on_hand, 0)`.mapWith(Number),
      })
      .from(v)
      .innerJoin(schema.products, eq(schema.products.id, v.productId))
      .leftJoin(sql`stock_levels sl`, sql`sl.variant_id = ${v.id} and sl.location_id = ${locationId}`)
      .where(
        and(
          eq(v.trackInventory, true),
          eq(v.status, 'active'),
          eq(schema.products.status, 'active'),
          sql`coalesce(sl.on_hand, 0) <= ${atOrBelow}`,
          sql`not exists (select 1 from purchase_order_lines pl join purchase_orders po on po.id = pl.purchase_order_id
                          where pl.variant_id = ${v.id} and po.location_id = ${locationId} and po.status in ('draft', 'ordered', 'partially_received'))`,
        ),
      )
      .orderBy(sql`coalesce(sl.on_hand, 0)`, asc(schema.products.name))
      .limit(200);
    return rows.map(({ productName, variantName, ...r }) => ({ ...r, description: variantName === 'Default' ? productName : `${productName} — ${variantName}` }));
  }

  private async lock(id: string): Promise<Order> {
    const [order] = await this.db.tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)).for('update');
    if (!order) throw new NotFoundException('Purchase order not found');
    return order;
  }

  private async checkDraft(input: DraftInput) {
    const [supplier] = await this.db.tx
      .select({ id: schema.suppliers.id })
      .from(schema.suppliers)
      .where(and(eq(schema.suppliers.id, input.supplierId), isNull(schema.suppliers.archivedAt)));
    if (!supplier) throw new BadRequestException('Choose an active supplier');
    const [location] = await this.db.tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(eq(schema.locations.id, input.locationId), isNull(schema.locations.archivedAt)));
    if (!location) throw new BadRequestException('Choose an open location');
    if (new Set(input.lines.map((l) => l.variantId)).size !== input.lines.length) throw new BadRequestException('Each item may appear once; change its quantity instead');
    if (!input.lines.length) return;
    const ids = input.lines.map((l) => l.variantId);
    const variants = await this.db.tx
      .select({ id: schema.productVariants.id, name: schema.productVariants.name, track: schema.productVariants.trackInventory })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, ids));
    if (variants.length !== ids.length) throw new BadRequestException('Some items no longer exist');
    const untracked = variants.filter((v) => !v.track);
    if (untracked.length) throw new BadRequestException('Stock isn’t tracked for some of these items, so they can’t be received');
  }

  private async writeLines(orderId: string, lines: DraftLine[]) {
    if (!lines.length) return;
    await this.db.tx.insert(schema.purchaseOrderLines).values(
      lines.map((l, position) => ({
        tenantId: currentTenant().tenantId,
        purchaseOrderId: orderId,
        position,
        variantId: l.variantId,
        quantityOrdered: l.quantity,
        unitCostMinor: l.unitCostMinor,
      })),
    );
  }
}

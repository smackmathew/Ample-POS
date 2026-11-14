import { randomInt } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { schema } from '@pos/db';
import { desc, eq, sql } from 'drizzle-orm';
import { Db } from '../core/database';
import { currentTenant, currentUserId } from '../core/request-context';

// No 0/O or 1/I, so codes read back over the phone without mistakes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Codes as people type them: any case, with spaces or dashes. Stored as uppercase letters and digits. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 16 characters (80 bits), so codes can't be guessed. */
export function generateCode(): string {
  return Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** ABCD-EFGH-JKLM-NPQR, for printing. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

export const last4 = (code: string) => code.slice(-4);

export const GIFT_CARD_MAX_MINOR = 1_000_000; // $10,000 on one card

type Entry = { giftCardId: string; kind: 'load' | 'redeem' | 'refund' | 'adjust' | 'void'; amountMinor: number; saleId?: string | null; paymentId?: string | null; refundId?: string | null; note?: string | null };

/** Gift cards and their balance ledger. */
@Injectable()
export class GiftCardService {
  constructor(private readonly db: Db) {}

  async enabled(): Promise<boolean> {
    const [row] = await this.db.tx
      .select({ enabled: schema.tenantModules.enabled })
      .from(schema.tenantModules)
      .where(eq(schema.tenantModules.moduleId, 'gift-cards'));
    return row?.enabled ?? false;
  }

  /** The card with this code, locked against other registers spending it at the same time. */
  async lockByCode(code: string) {
    const [card] = await this.db.tx.select().from(schema.giftCards).where(eq(schema.giftCards.code, normalizeCode(code))).for('update');
    return card ?? null;
  }

  async lock(id: string) {
    const [card] = await this.db.tx.select().from(schema.giftCards).where(eq(schema.giftCards.id, id)).for('update');
    if (!card) throw new NotFoundException('Gift card not found');
    return card;
  }

  async findByCode(code: string) {
    const [card] = await this.db.tx.select().from(schema.giftCards).where(eq(schema.giftCards.code, normalizeCode(code)));
    return card ?? null;
  }

  async balance(id: string): Promise<number> {
    const [row] = await this.db.tx
      .select({ total: sql<number>`coalesce(sum(${schema.giftCardEntries.amountMinor}), 0)`.mapWith(Number) })
      .from(schema.giftCardEntries)
      .where(eq(schema.giftCardEntries.giftCardId, id));
    return row?.total ?? 0;
  }

  async entries(id: string) {
    const e = schema.giftCardEntries;
    return this.db.tx
      .select({ id: e.id, kind: e.kind, amountMinor: e.amountMinor, note: e.note, saleId: e.saleId, receiptNumber: schema.sales.receiptNumber, createdAt: e.createdAt })
      .from(e)
      .leftJoin(schema.sales, eq(schema.sales.id, e.saleId))
      .where(eq(e.giftCardId, id))
      .orderBy(desc(e.createdAt), desc(e.id))
      .limit(200);
  }

  async record(entry: Entry) {
    if (entry.amountMinor === 0) return;
    await this.db.tx.insert(schema.giftCardEntries).values({
      tenantId: currentTenant().tenantId,
      giftCardId: entry.giftCardId,
      kind: entry.kind,
      amountMinor: entry.amountMinor,
      saleId: entry.saleId ?? null,
      paymentId: entry.paymentId ?? null,
      refundId: entry.refundId ?? null,
      note: entry.note ?? null,
      createdBy: currentUserId(),
    });
  }

  /**
   * Checks a code for selling: a new code (or none, to make one up), or an
   * active card to reload. Returns the code to put on the sale line.
   */
  async codeForSale(requested: string | undefined, amountMinor: number): Promise<{ code: string; reload: boolean }> {
    if (!requested) {
      for (;;) {
        const code = generateCode();
        if (!(await this.findByCode(code))) return { code, reload: false };
      }
    }
    const code = normalizeCode(requested);
    if (code.length < 8 || code.length > 32) throw new BadRequestException('A gift card code has 8 to 32 letters and digits');
    const card = await this.findByCode(code);
    if (!card) return { code, reload: false };
    if (card.status === 'void') throw new ConflictException('That gift card was voided and can’t be reloaded');
    if ((await this.balance(card.id)) + amountMinor > GIFT_CARD_MAX_MINOR) throw new BadRequestException('A gift card can hold at most $10,000');
    return { code, reload: true };
  }

  /** Puts a sold amount on its card, making the card if it's new. */
  async load(code: string, amountMinor: number, saleId: string) {
    let card: typeof schema.giftCards.$inferSelect | null | undefined = await this.lockByCode(code);
    if (!card) {
      [card] = await this.db.tx.insert(schema.giftCards).values({ tenantId: currentTenant().tenantId, code }).returning();
    }
    await this.record({ giftCardId: card!.id, kind: 'load', amountMinor, saleId });
  }

  /** A short description of a card a customer holds, without its full code. */
  async summary(cardId: string) {
    const [card] = await this.db.tx.select().from(schema.giftCards).where(eq(schema.giftCards.id, cardId));
    if (!card) return null;
    return { id: card.id, last4: last4(card.code), status: card.status, balanceMinor: await this.balance(card.id) };
  }

  async issue(input: { code?: string; amountMinor: number; note: string }) {
    const { code } = await this.codeForSale(input.code, input.amountMinor);
    if (await this.findByCode(code)) throw new ConflictException('A gift card with that code already exists');
    const [card] = await this.db.tx.insert(schema.giftCards).values({ tenantId: currentTenant().tenantId, code }).returning();
    await this.record({ giftCardId: card!.id, kind: 'adjust', amountMinor: input.amountMinor, note: input.note });
    return card!;
  }
}

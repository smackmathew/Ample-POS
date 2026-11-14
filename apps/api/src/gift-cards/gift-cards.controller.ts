import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { desc, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { RateLimiter } from '../core/rate-limit';
import { currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { formatCode, GIFT_CARD_MAX_MINOR, GiftCardService, last4, normalizeCode } from './gift-cards.service';

const balanceQuery = z.object({ code: z.string().trim().min(1).max(64) });
const listQuery = z.object({ search: z.string().trim().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const note = z.string().trim().min(1, 'Say why, so the history makes sense later').max(200);
const issueBody = z.object({ code: z.string().trim().max(64).optional(), amountMinor: z.number().int().min(100).max(GIFT_CARD_MAX_MINOR), note });
const adjustBody = z.object({
  amountMinor: z
    .number()
    .int()
    .min(-GIFT_CARD_MAX_MINOR)
    .max(GIFT_CARD_MAX_MINOR)
    .refine((n) => n !== 0, 'Enter an amount to add or take off'),
  note,
});
const voidBody = z.object({ note });

/** Gift cards: checking a balance at the register, and managing cards. */
@Controller('gift-cards')
@RequireModule('gift-cards')
export class GiftCardsController {
  constructor(
    private readonly db: Db,
    private readonly cards: GiftCardService,
    private readonly limiter: RateLimiter,
    private readonly events: Events,
  ) {}

  /** What's left on a card, for whoever holds its code. Limited, so codes can't be tried in bulk. */
  @RequirePermission('pos.sell')
  @Get('balance')
  async balance(@Query(new ZodPipe(balanceQuery)) q: z.infer<typeof balanceQuery>) {
    const key = `giftcard-lookup:${currentUserId()}`;
    this.limiter.check(key, 30, 'Too many gift card lookups. Try again in a few minutes.');
    this.limiter.hit(key, 10 * 60_000);
    const card = await this.cards.findByCode(q.code);
    if (!card) throw new NotFoundException('No gift card has that code');
    return { last4: last4(card.code), status: card.status, balanceMinor: await this.cards.balance(card.id) };
  }

  @RequirePermission('giftcards.manage')
  @Get()
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const g = schema.giftCards;
    const search = q.search ? normalizeCode(q.search) : '';
    return (
      await this.db.tx
        .select({
          id: g.id,
          code: g.code,
          status: g.status,
          createdAt: g.createdAt,
          balanceMinor: sql<number>`(select coalesce(sum(e.amount_minor), 0) from gift_card_entries e where e.gift_card_id = gift_cards.id)`.mapWith(Number),
          lastUsedAt: sql<string | null>`(select max(e.created_at) from gift_card_entries e where e.gift_card_id = gift_cards.id)`,
        })
        .from(g)
        .where(search ? like(g.code, `%${search}%`) : undefined)
        .orderBy(desc(g.createdAt))
        .limit(q.limit)
    ).map((c) => ({ ...c, code: formatCode(c.code), last4: last4(c.code) }));
  }

  @RequirePermission('giftcards.manage')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [card] = await this.db.tx.select().from(schema.giftCards).where(eq(schema.giftCards.id, id));
    if (!card) throw new NotFoundException('Gift card not found');
    const [balanceMinor, entries] = await Promise.all([this.cards.balance(id), this.cards.entries(id)]);
    return { id: card.id, code: formatCode(card.code), last4: last4(card.code), status: card.status, createdAt: card.createdAt, balanceMinor, entries };
  }

  /** Gives out a card without a sale (a donation, a make-good). */
  @RequirePermission('giftcards.manage')
  @Post()
  async issue(@Body(new ZodPipe(issueBody)) body: z.infer<typeof issueBody>) {
    const card = await this.cards.issue(body);
    await this.events.audit('gift_card.issued', { type: 'gift_card', id: card.id }, { amountMinor: body.amountMinor, note: body.note });
    return this.get(card.id);
  }

  @RequirePermission('giftcards.manage')
  @Post(':id/adjust')
  async adjust(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjustBody)) body: z.infer<typeof adjustBody>) {
    const card = await this.cards.lock(id);
    if (card.status !== 'active') throw new BadRequestException('This gift card was voided');
    const balance = await this.cards.balance(id);
    if (balance + body.amountMinor < 0) throw new BadRequestException('A gift card’s balance can’t go below zero');
    if (balance + body.amountMinor > GIFT_CARD_MAX_MINOR) throw new BadRequestException('A gift card can hold at most $10,000');
    await this.cards.record({ giftCardId: id, kind: 'adjust', amountMinor: body.amountMinor, note: body.note });
    await this.events.audit('gift_card.adjusted', { type: 'gift_card', id }, { amountMinor: body.amountMinor, note: body.note });
    return this.get(id);
  }

  /** Stops a card for good (lost or stolen), taking off whatever was left. */
  @RequirePermission('giftcards.manage')
  @Post(':id/void')
  async void(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(voidBody)) body: z.infer<typeof voidBody>) {
    const card = await this.cards.lock(id);
    if (card.status === 'void') return this.get(id);
    const balance = await this.cards.balance(id);
    await this.cards.record({ giftCardId: id, kind: 'void', amountMinor: -balance, note: body.note });
    await this.db.tx.update(schema.giftCards).set({ status: 'void' }).where(eq(schema.giftCards.id, id));
    await this.events.audit('gift_card.voided', { type: 'gift_card', id }, { balanceMinor: balance, note: body.note });
    return this.get(id);
  }
}

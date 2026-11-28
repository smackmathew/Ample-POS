import { Body, Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { schema } from '@pos/db';
import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { hashApiSecret, newApiKey } from '../core/api-keys';
import { Db } from '../core/database';
import { NoApiKey, Public, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { RateLimiter } from '../core/rate-limit';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';

/** Letters and digits that can't be mistaken for each other (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_MINUTES = 15;
const WINDOW = 15 * 60_000;

const pairBody = z.object({
  code: z.string().trim().min(8).max(20),
  computer: z.string().trim().max(100).optional(),
});

/** The code as typed (any case, with or without the dash), or null if it can't be one. */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/**
 * Connecting the Migration Assistant, the Windows app that reads QuickBooks
 * POS on the store's PC and sends its data through the imports here.
 */
@Controller('migration/assistant')
export class AssistantController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
    private readonly limiter: RateLimiter,
  ) {}

  /** A one-time code to type into the Assistant. Valid for 15 minutes. */
  @RequirePermission('data.manage')
  @NoApiKey()
  @Post('pairing-codes')
  async code() {
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
    const [row] = await this.db.tx
      .insert(schema.assistantPairings)
      .values({ tenantId: currentTenant().tenantId, createdBy: currentUserId(), codeHash: hashApiSecret(code), expiresAt })
      .returning({ id: schema.assistantPairings.id });
    await this.events.audit('migration.assistant_code_created', { type: 'assistant_pairing', id: row!.id }, {});
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  /**
   * The Assistant trades a code for its API key (imports only, acting for the
   * person who made the code). Each code works once.
   */
  @Public()
  @Post('pair')
  @HttpCode(200)
  async pair(@Body(new ZodPipe(pairBody)) body: z.infer<typeof pairBody>, @Req() req: Request) {
    this.limiter.check(`assistant-pair:${req.ip}`, 10, 'Too many wrong codes. Wait a few minutes and make a new code.');
    const code = normalizePairingCode(body.code);
    const key = newApiKey();
    const [row] = code
      ? await this.db.pool.execute<{ tenant_id: string; tenant_name: string }>(
          sql`select * from app_redeem_assistant_pairing(${hashApiSecret(code)}, ${key.id}::uuid, ${key.hint}, ${key.secretHash}, ${body.computer ?? null})`,
        )
      : [];
    if (!row) {
      this.limiter.hit(`assistant-pair:${req.ip}`, WINDOW);
      throw new UnauthorizedException({
        code: 'bad_pairing_code',
        message: 'That code didn’t work. Codes work once, for 15 minutes; make a new one in Ample POS.',
      });
    }
    return { apiKey: key.key, tenantId: row.tenant_id, businessName: row.tenant_name };
  }
}

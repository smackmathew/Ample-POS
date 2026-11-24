import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { schema } from '@pos/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';
import { MerchantService } from './merchant.service';

const ownBody = z.object({
  secretKey: z
    .string()
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'Paste a Stripe secret key (sk_live_… or sk_test_…) or restricted key (rk_…)'),
  webhookSecret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9]{10,}$/, 'A webhook signing secret starts with whsec_')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/** How the business takes card payments: built in (Stripe Express) or its own Stripe account. */
@Controller('payments/merchant')
@RequireModule('pos')
@RequirePermission('pos.payments.manage')
export class MerchantController {
  constructor(
    private readonly merchant: MerchantService,
    private readonly db: Db,
  ) {}

  @Get()
  view() {
    return this.merchant.view();
  }

  @Post('platform')
  @HttpCode(200)
  async platform() {
    const [me] = await this.db.tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, currentUserId()));
    return this.merchant.startPlatform(me?.email ?? null);
  }

  @Put('own')
  own(@Body(new ZodPipe(ownBody)) body: z.infer<typeof ownBody>) {
    return this.merchant.connectOwn(body.secretKey, body.webhookSecret ?? null);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh() {
    return this.merchant.refresh();
  }

  @Post('dashboard')
  @HttpCode(200)
  dashboard() {
    return this.merchant.dashboardLink();
  }

  @Post('off')
  @HttpCode(200)
  off() {
    return this.merchant.turnOff();
  }
}

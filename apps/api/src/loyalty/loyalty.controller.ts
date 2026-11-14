import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { schema } from '@pos/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { ZodPipe } from '../core/zod';
import { LoyaltyService } from './loyalty.service';

const programBody = z.object({
  pointsPerDollar: z.number().int().min(1, 'Earn at least 1 point per dollar').max(100),
  rewardPoints: z.number().int().min(1, 'A reward costs at least 1 point').max(1_000_000),
  rewardValueMinor: z.number().int().min(1, 'A reward is worth at least 1 cent').max(100_000_000),
});
const adjustBody = z.object({
  points: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, 'Enter a number of points to add or take away'),
  note: z.string().trim().min(1, 'Say why, so the history makes sense later').max(200),
});

/** The rewards program's settings, and customers' points. */
@Controller('loyalty')
@RequireModule('loyalty')
export class LoyaltyController {
  constructor(
    private readonly db: Db,
    private readonly loyalty: LoyaltyService,
    private readonly events: Events,
  ) {}

  @RequirePermission('customers.use')
  @Get('program')
  program() {
    return this.loyalty.program();
  }

  @RequirePermission('loyalty.manage')
  @Put('program')
  async saveProgram(@Body(new ZodPipe(programBody)) body: z.infer<typeof programBody>) {
    const program = await this.loyalty.saveProgram(body);
    await this.events.audit('loyalty.program_updated', { type: 'loyalty_program', id: 'program' }, { ...program });
    return program;
  }

  /** A customer's balance and point history, newest first. */
  @RequirePermission('customers.use')
  @Get('customers/:id')
  async customer(@Param('id', ParseUUIDPipe) id: string) {
    await this.findCustomer(id);
    const [program, balance, entries] = await Promise.all([this.loyalty.program(), this.loyalty.balance(id), this.loyalty.entries(id)]);
    return { balance, rewardsAvailable: Math.max(0, Math.floor(balance / program.rewardPoints)), program, entries };
  }

  /** Adds or takes away points by hand, with a reason (a goodwill gesture, a correction). */
  @RequirePermission('loyalty.manage')
  @Post('customers/:id/adjust')
  async adjust(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjustBody)) body: z.infer<typeof adjustBody>) {
    await this.findCustomer(id);
    await this.loyalty.lockCustomer(id);
    await this.loyalty.record({ customerId: id, kind: 'adjust', points: body.points, note: body.note });
    await this.events.audit('loyalty.points_adjusted', { type: 'customer', id }, { points: body.points, note: body.note });
    return this.customer(id);
  }

  private async findCustomer(id: string) {
    const [c] = await this.db.tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, id));
    if (!c) throw new NotFoundException('Customer not found');
  }
}

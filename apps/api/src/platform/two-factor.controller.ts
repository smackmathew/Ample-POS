import { BadRequestException, Body, ConflictException, Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuthService } from '../core/auth.service';
import { Db } from '../core/database';
import { NoTenant } from '../core/decorators';
import { PASSWORD_MAX, verifyPassword } from '../core/passwords';
import { RateLimiter } from '../core/rate-limit';
import { currentContext } from '../core/request-context';
import { newTotpSecret, matchTotp, otpauthUri } from '../core/totp';
import { TwoFactor } from '../core/two-factor';
import { ZodPipe } from '../core/zod';

const password = z.string().min(1, 'Enter your password').max(PASSWORD_MAX);
const code = z.string().trim().min(6, 'Enter the code').max(20);
const setupBody = z.object({ password });
const enableBody = z.object({ code });
const confirmedBody = z.object({ password, code });

const WINDOW = 15 * 60_000;

/** A text[] parameter (drizzle would otherwise spread an array into a list). */
const textArray = (values: string[]) => sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/**
 * Turning two-step sign-in on and off for the signed-in account. Every change
 * asks for the password again, so an unattended signed-in browser can't
 * switch it off or read new recovery codes.
 */
@Controller('auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactor,
    private readonly limiter: RateLimiter,
  ) {}

  /** Starts enrolment: a new secret for the authenticator app. Nothing changes until enable. */
  @NoTenant()
  @Post('setup')
  @HttpCode(200)
  async setup(@Body(new ZodPipe(setupBody)) body: z.infer<typeof setupBody>) {
    const userId = await this.reauthenticate(body.password);
    const secret = newTotpSecret();
    const [row] = await this.db.pool.execute<{ ok: boolean | null }>(sql`select app_two_factor_begin(${userId}::uuid, ${secret}) as ok`);
    if (!row?.ok) throw new ConflictException('Two-step sign-in is already on. Turn it off first to set up a new app.');
    const [me] = await currentContext().tx.execute<{ email: string }>(sql`select email from users where id = ${userId}`);
    return { secret, otpauthUri: otpauthUri(secret, me?.email ?? 'account') };
  }

  /** The first good code from the app turns two-step on and returns the recovery codes, once. */
  @NoTenant()
  @Post('enable')
  @HttpCode(200)
  async enable(@Body(new ZodPipe(enableBody)) body: z.infer<typeof enableBody>) {
    const userId = this.userId();
    this.limiter.check(`2fa:${userId}`, 10);
    const state = await this.twoFactor.state(userId);
    if (state.enabled) throw new ConflictException('Two-step sign-in is already on');
    if (!state.secret) throw new BadRequestException('Start setup first');
    const step = matchTotp(state.secret, body.code);
    if (step === null) {
      this.limiter.hit(`2fa:${userId}`, WINDOW);
      throw new BadRequestException({ message: 'That code didn’t match. Check the time on your phone and try the newest code.', issues: [{ path: 'code', message: 'That code didn’t match' }] });
    }
    const { codes, hashes } = this.twoFactor.freshRecoveryCodes();
    await this.db.pool.execute(sql`select app_two_factor_confirm(${userId}::uuid, ${step}, ${textArray(hashes)})`);
    return { recoveryCodes: codes };
  }

  @NoTenant()
  @Post('disable')
  @HttpCode(200)
  async disable(@Body(new ZodPipe(confirmedBody)) body: z.infer<typeof confirmedBody>) {
    const userId = await this.reauthenticate(body.password, body.code);
    await this.db.pool.execute(sql`select app_two_factor_disable(${userId}::uuid)`);
    return { ok: true };
  }

  /** Replaces all recovery codes (the old ones stop working). */
  @NoTenant()
  @Post('recovery-codes')
  @HttpCode(200)
  async recoveryCodes(@Body(new ZodPipe(confirmedBody)) body: z.infer<typeof confirmedBody>) {
    const userId = await this.reauthenticate(body.password, body.code);
    const { codes, hashes } = this.twoFactor.freshRecoveryCodes();
    await this.db.pool.execute(sql`select app_two_factor_set_recovery(${userId}::uuid, ${textArray(hashes)})`);
    return { recoveryCodes: codes };
  }

  private userId(): string {
    if (this.auth.mode !== 'password') throw new NotFoundException();
    return currentContext().user!.userId;
  }

  /** Password (and, when two-step is on, a code) for sensitive changes. */
  private async reauthenticate(password: string, totp?: string): Promise<string> {
    const userId = this.userId();
    this.limiter.check(`2fa:${userId}`, 10);
    const [row] = await this.db.pool.execute<{ hash: string | null }>(sql`select app_password_hash(${userId}::uuid) as hash`);
    if (totp !== undefined && !(await this.twoFactor.state(userId)).enabled) throw new ConflictException('Two-step sign-in is not on');
    const passwordOk = Boolean(row?.hash) && (await verifyPassword(password, row!.hash!));
    const codeOk = totp === undefined || (passwordOk && (await this.twoFactor.check(userId, totp)));
    if (!passwordOk || !codeOk) {
      this.limiter.hit(`2fa:${userId}`, WINDOW);
      const message = passwordOk ? 'That code didn’t match' : 'Your password is incorrect';
      throw new BadRequestException({ message, issues: [{ path: passwordOk ? 'code' : 'password', message }] });
    }
    return userId;
  }
}

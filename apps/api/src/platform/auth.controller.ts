import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject, Logger, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, newToken, SESSION_DAYS, splitToken, sha256 } from '../core/auth.service';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { NoTenant, Public } from '../core/decorators';
import { EmailVerification } from '../core/email-verification';
import { Mailer } from '../core/mailer';
import { DUMMY_HASH, hashPassword, normalizeEmail, PASSWORD_MAX, passwordProblem, verifyPassword } from '../core/passwords';
import { RateLimiter } from '../core/rate-limit';
import { currentContext } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const email = z.string().trim().email('Enter a valid email').max(254).transform(normalizeEmail);
const password = z.string().min(1, 'Enter your password').max(PASSWORD_MAX);
const signupBody = z.object({ email, password, name: z.string().trim().min(1, 'Enter your name').max(100) });
const loginBody = z.object({ email, password });
const changeBody = z.object({ currentPassword: password, newPassword: password });
const forgotBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(1).max(200), password });
const verifyBody = z.object({ token: z.string().min(1).max(200) });
const emailChangeBody = z.object({ newEmail: email, password });

const WINDOW = 15 * 60_000;

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Built-in accounts (AUTH_MODE=password). Sign-in hands out an opaque session
 * token ("<id>.<secret>") that the web hub keeps in an httpOnly cookie and the
 * app in the device keychain; every request checks it against the database,
 * so signing out (or a password change) takes effect at once.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly limiter: RateLimiter,
    private readonly mailer: Mailer,
    private readonly verification: EmailVerification,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Which sign-in screens to show. */
  @Public()
  @Get('config')
  authConfig() {
    const byEmail = this.auth.mode === 'password' && this.mailer.enabled;
    return { mode: this.auth.mode, passwordResetByEmail: byEmail, emailVerification: this.verification.enforced };
  }

  @Public()
  @Post('signup')
  async signup(@Body(new ZodPipe(signupBody)) body: z.infer<typeof signupBody>, @Req() req: Request) {
    this.requirePasswordMode();
    this.limiter.check(`signup:${req.ip}`, 20, 'Too many new accounts from this network. Try again later.');
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw new BadRequestException({ message: problem, issues: [{ path: 'password', message: problem }] });
    this.limiter.hit(`signup:${req.ip}`, 60 * 60_000);

    const [row] = await this.db.pool.execute<{ id: string | null }>(
      sql`select app_register_account(${body.email}, ${await hashPassword(body.password)}, ${body.name}) as id`,
    );
    if (!row?.id) {
      throw new HttpException({ statusCode: 409, code: 'email_taken', message: 'An account with this email already exists. Sign in, or reset your password.' }, 409);
    }
    const token = await this.startSession(row.id, req);
    await this.verification.send(row.id);
    return { token };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginBody)) body: z.infer<typeof loginBody>, @Req() req: Request) {
    this.requirePasswordMode();
    // Failures only: a shared office network shouldn't lock everyone out after a busy morning.
    this.limiter.check(`login-ip:${req.ip}`, 50);
    this.limiter.check(`login-email:${body.email}`, 10);

    const [account] = await this.db.pool.execute<{ user_id: string; password_hash: string; locked_until: Date | null }>(
      sql`select * from app_account_for_login(${body.email})`,
    );
    const ok = await verifyPassword(body.password, account?.password_hash ?? DUMMY_HASH);
    if (account?.locked_until && new Date(account.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(account.locked_until).getTime() - Date.now()) / 60_000);
      throw new HttpException({ statusCode: 429, code: 'account_locked', message: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.` }, 429);
    }
    if (!account || !ok) {
      this.limiter.hit(`login-ip:${req.ip}`, WINDOW);
      this.limiter.hit(`login-email:${body.email}`, WINDOW);
      if (account) await this.db.pool.execute(sql`select app_login_failed(${account.user_id}::uuid)`);
      throw new UnauthorizedException({ code: 'bad_credentials', message: 'Email or password is incorrect' });
    }
    return { token: await this.startSession(account.user_id, req) };
  }

  @NoTenant()
  @Post('logout')
  @HttpCode(200)
  async logout() {
    await this.endSessions(false);
    return { ok: true };
  }

  /** Signs out every device, including this one. */
  @NoTenant()
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll() {
    await this.endSessions(true);
    return { ok: true };
  }

  /** Change password; other devices are signed out, this one stays signed in. */
  @NoTenant()
  @Post('password')
  @HttpCode(200)
  async changePassword(@Body(new ZodPipe(changeBody)) body: z.infer<typeof changeBody>) {
    this.requirePasswordMode();
    const { user, tx } = currentContext();
    this.limiter.check(`change:${user!.userId}`, 10);
    const [row] = await tx.execute<{ hash: string | null }>(sql`select app_password_hash(${user!.userId}::uuid) as hash`);
    if (!row?.hash || !(await verifyPassword(body.currentPassword, row.hash))) {
      this.limiter.hit(`change:${user!.userId}`, WINDOW);
      throw new BadRequestException({ message: 'Your current password is incorrect', issues: [{ path: 'currentPassword', message: 'Your current password is incorrect' }] });
    }
    const [me] = await tx.execute<{ email: string }>(sql`select email from users where id = ${user!.userId}`);
    const problem = passwordProblem(body.newPassword, me?.email ?? '');
    if (problem) throw new BadRequestException({ message: problem, issues: [{ path: 'newPassword', message: problem }] });
    await tx.execute(sql`select app_set_password(${user!.userId}::uuid, ${await hashPassword(body.newPassword)}, ${user!.sessionId}::uuid)`);
    return { ok: true };
  }

  /** Emails a reset link. Answers the same whether or not the account exists. */
  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  async forgot(@Body(new ZodPipe(forgotBody)) body: z.infer<typeof forgotBody>, @Req() req: Request) {
    this.requirePasswordMode();
    if (!this.mailer.enabled) throw new NotFoundException('Password reset by email is not set up. Ask the business owner for a reset link.');
    this.limiter.check(`forgot-ip:${req.ip}`, 20);
    this.limiter.check(`forgot-email:${body.email}`, 3, 'A reset email was just sent. Check your inbox, or try again in a few minutes.');
    this.limiter.hit(`forgot-ip:${req.ip}`, WINDOW);
    this.limiter.hit(`forgot-email:${body.email}`, WINDOW);

    const { secret, secretHash } = newToken();
    const [reset] = await this.db.pool.execute<{ reset_id: string }>(sql`select * from app_create_password_reset(${body.email}, ${secretHash})`);
    if (reset) {
      const link = `${this.config.WEB_URL}/reset?token=${reset.reset_id}.${secret}`;
      await this.mailer
        .send(
          body.email,
          'Reset your Ample POS password',
          `Someone asked to reset the password for this Ample POS account.\n\nTo choose a new password, open this link within an hour:\n${link}\n\nIf this wasn’t you, ignore this email; your password stays the same.`,
        )
        .catch((err: Error) => this.logger.error(err.message));
    }
    return { ok: true };
  }

  /** Spends a reset link (emailed, or made by a manager in the hub) and signs in. */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body(new ZodPipe(resetBody)) body: z.infer<typeof resetBody>, @Req() req: Request) {
    this.requirePasswordMode();
    this.limiter.check(`reset-ip:${req.ip}`, 30);
    const parts = splitToken(body.token);
    const problem = passwordProblem(body.password, '');
    if (problem) throw new BadRequestException({ message: problem, issues: [{ path: 'password', message: problem }] });
    const [row] = parts
      ? await this.db.pool.execute<{ user_id: string | null }>(
          sql`select app_use_password_reset(${parts.id}::uuid, ${sha256(parts.secret)}, ${await hashPassword(body.password)}) as user_id`,
        )
      : [];
    if (!row?.user_id) {
      this.limiter.hit(`reset-ip:${req.ip}`, WINDOW);
      throw new BadRequestException({ code: 'reset_invalid', message: 'This reset link has expired or was already used. Ask for a new one.' });
    }
    return { token: await this.startSession(row.user_id, req) };
  }

  /** Sends a fresh verification link to the signed-in account's email. */
  @NoTenant()
  @Post('email/verify-request')
  @HttpCode(200)
  async requestVerification() {
    if (!this.verification.enforced) throw new NotFoundException();
    const { user } = currentContext();
    this.limiter.check(`verify-send:${user!.userId}`, 3, 'A confirmation email was just sent. Check your inbox, or try again in a few minutes.');
    this.limiter.hit(`verify-send:${user!.userId}`, WINDOW);
    return { sent: await this.verification.send(user!.userId) };
  }

  /** Spends the emailed link. No sign-in needed: the link itself is the proof. */
  @Public()
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@Body(new ZodPipe(verifyBody)) body: z.infer<typeof verifyBody>, @Req() req: Request) {
    this.limiter.check(`verify-ip:${req.ip}`, 30);
    const parts = splitToken(body.token);
    const [row] = parts
      ? await this.db.pool.execute<{ email: string | null }>(sql`select app_verify_email(${parts.id}::uuid, ${sha256(parts.secret)}) as email`)
      : [];
    if (!row?.email) {
      this.limiter.hit(`verify-ip:${req.ip}`, WINDOW);
      throw new BadRequestException({ code: 'verify_invalid', message: 'This confirmation link has expired or was already used. Sign in to get a new one.' });
    }
    return { email: row.email };
  }

  /**
   * Changes the sign-in email after checking the current password. With email
   * available the new address must confirm a link first; without it the change
   * is immediate (and the address unconfirmed).
   */
  @NoTenant()
  @Post('email/change')
  @HttpCode(200)
  async changeEmail(@Body(new ZodPipe(emailChangeBody)) body: z.infer<typeof emailChangeBody>) {
    this.requirePasswordMode();
    const { user } = currentContext();
    const userId = user!.userId;
    this.limiter.check(`change:${userId}`, 10);
    const [row] = await this.db.pool.execute<{ hash: string | null }>(sql`select app_password_hash(${userId}::uuid) as hash`);
    if (!row?.hash || !(await verifyPassword(body.password, row.hash))) {
      this.limiter.hit(`change:${userId}`, WINDOW);
      throw new BadRequestException({ message: 'Your password is incorrect', issues: [{ path: 'password', message: 'Your password is incorrect' }] });
    }

    try {
      if (!this.mailer.enabled) {
        await this.db.pool.execute(sql`select app_apply_email_change(${userId}::uuid, ${body.newEmail}, false)`);
        return { status: 'changed' as const, email: body.newEmail };
      }
      this.limiter.check(`email-change:${userId}`, 3, 'A confirmation email was just sent. Check that inbox, or try again in a few minutes.');
      this.limiter.hit(`email-change:${userId}`, WINDOW);
      const { secret, secretHash } = newToken();
      const [change] = await this.db.pool.execute<{ id: string }>(
        sql`select app_request_email_change(${userId}::uuid, ${body.newEmail}, ${secretHash}) as id`,
      );
      await this.mailer.send(
        body.newEmail,
        'Confirm your new email for Ample POS',
        `Someone asked to use this address for their Ample POS account.\n\nTo confirm, open this link within 24 hours:\n${this.config.WEB_URL}/email-change?token=${change!.id}.${secret}\n\nIf this wasn’t you, ignore this email; nothing will change.`,
      );
      return { status: 'confirm_sent' as const, email: body.newEmail };
    } catch (err) {
      if (pgCode(err) === '23505') {
        throw new HttpException({ statusCode: 409, code: 'email_taken', message: 'Another account already uses that email' }, 409);
      }
      throw err;
    }
  }

  /** Spends the link sent to the new address, then lets the old address know. */
  @Public()
  @Post('email/change/confirm')
  @HttpCode(200)
  async confirmEmailChange(@Body(new ZodPipe(verifyBody)) body: z.infer<typeof verifyBody>, @Req() req: Request) {
    this.limiter.check(`verify-ip:${req.ip}`, 30);
    const parts = splitToken(body.token);
    let row: { user_id: string; old_email: string; new_email: string } | undefined;
    try {
      [row] = parts
        ? await this.db.pool.execute<{ user_id: string; old_email: string; new_email: string }>(
            sql`select * from app_confirm_email_change(${parts.id}::uuid, ${sha256(parts.secret)})`,
          )
        : [];
    } catch (err) {
      if (pgCode(err) === '23505') {
        throw new HttpException({ statusCode: 409, code: 'email_taken', message: 'Another account started using that email in the meantime' }, 409);
      }
      throw err;
    }
    if (!row) {
      this.limiter.hit(`verify-ip:${req.ip}`, WINDOW);
      throw new BadRequestException({ code: 'change_invalid', message: 'This link has expired or was already used. Request the change again from your account page.' });
    }
    await this.mailer
      .send(
        row.old_email,
        'Your Ample POS email was changed',
        `The email for your Ample POS account was changed from ${row.old_email} to ${row.new_email}.\n\nIf you did this, there’s nothing else to do. If you didn’t, contact the owner of your business right away: someone who knows your password may have changed it.`,
      )
      .catch((err: Error) => this.logger.error(err.message));
    return { email: row.new_email };
  }

  private async startSession(userId: string, req: Request): Promise<string> {
    const { secret, secretHash } = newToken();
    const [row] = await this.db.pool.execute<{ id: string }>(
      sql`select app_start_session(${userId}::uuid, ${secretHash}, ${req.headers['user-agent'] ?? null}, ${SESSION_DAYS}) as id`,
    );
    return `${row!.id}.${secret}`;
  }

  private async endSessions(everywhere: boolean) {
    const { user, tx } = currentContext();
    if (user?.sessionId) await tx.execute(sql`select app_end_sessions(${user.sessionId}::uuid, ${everywhere}, null)`);
  }

  private requirePasswordMode() {
    if (this.auth.mode !== 'password') throw new NotFoundException();
  }
}

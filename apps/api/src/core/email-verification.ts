import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuthService, newToken } from './auth.service';
import { APP_CONFIG, type AppConfig } from './config';
import { Db } from './database';
import { Mailer } from './mailer';

/**
 * Proving an account owns its email. Only enforced for built-in accounts while
 * the API can send email; without email there is no way to verify, so nothing
 * is held back.
 */
@Injectable()
export class EmailVerification {
  private readonly logger = new Logger('EmailVerification');

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get enforced(): boolean {
    return this.auth.mode === 'password' && this.mailer.enabled;
  }

  async status(userId: string): Promise<{ hasPassword: boolean; emailVerified: boolean }> {
    const [row] = await this.db.pool.execute<{ has_password: boolean; email_verified: boolean }>(
      sql`select * from app_account_status(${userId}::uuid)`,
    );
    return { hasPassword: Boolean(row?.has_password), emailVerified: row?.email_verified ?? true };
  }

  /** Throws 403 email_unverified when verification is enforced and this account hasn't verified. */
  async require(userId: string, action: string): Promise<void> {
    if (!this.enforced || (await this.status(userId)).emailVerified) return;
    throw new ForbiddenException({ code: 'email_unverified', message: `Confirm your email address before you ${action}. Check your inbox for the link.` });
  }

  /** Emails a verification link if there is something to verify. Returns whether one was sent. */
  async send(userId: string): Promise<boolean> {
    if (!this.enforced) return false;
    const { secret, secretHash } = newToken();
    const [row] = await this.db.pool.execute<{ verification_id: string; email: string }>(
      sql`select * from app_create_email_verification(${userId}::uuid, ${secretHash})`,
    );
    if (!row) return false;
    const link = `${this.config.WEB_URL}/verify?token=${row.verification_id}.${secret}`;
    try {
      await this.mailer.send(
        row.email,
        'Confirm your email for Ample POS',
        `Welcome to Ample POS.\n\nConfirm this is your email address by opening this link within 24 hours:\n${link}\n\nIf you didn’t create an Ample POS account, ignore this email.`,
      );
      return true;
    } catch (err) {
      this.logger.error((err as Error).message);
      return false;
    }
  }
}

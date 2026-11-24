import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { eq } from 'drizzle-orm';
import { AuthService } from '../core/auth.service';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { EmailVerification } from '../core/email-verification';
import { currentContext, currentUserId } from '../core/request-context';
import { TwoFactor } from '../core/two-factor';

export interface PlatformAdmin {
  userId: string;
  email: string;
}

/**
 * Who may use the super admin dashboard: people whose email is in
 * PLATFORM_ADMIN_EMAILS. With built-in accounts, the email must be confirmed
 * and two-step sign-in on, since this dashboard can switch off any business.
 */
@Injectable()
export class PlatformAccess {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly verification: EmailVerification,
    private readonly twoFactor: TwoFactor,
  ) {}

  async check(): Promise<{ ok: true; admin: PlatformAdmin } | { ok: false; code: string; message: string }> {
    const userId = currentUserId();
    const [user] = await currentContext().tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
    const email = user?.email?.toLowerCase() ?? '';
    if (!email || !this.config.PLATFORM_ADMIN_EMAILS.includes(email)) {
      return { ok: false, code: 'not_platform_admin', message: 'This page is for Ample POS staff' };
    }
    if (this.auth.mode === 'password') {
      const status = await this.verification.status(userId);
      if (!status.hasPassword || !status.emailVerified) return { ok: false, code: 'email_unverified', message: 'Confirm your email address first' };
      if (!(await this.twoFactor.state(userId)).enabled) {
        return { ok: false, code: 'two_step_required', message: 'Turn on two-step sign-in in Your account to use the super admin dashboard' };
      }
    }
    return { ok: true, admin: { userId, email } };
  }

  async require(): Promise<PlatformAdmin> {
    const result = await this.check();
    if (!result.ok) throw new ForbiddenException({ statusCode: 403, code: result.code, message: result.message });
    return result.admin;
  }
}

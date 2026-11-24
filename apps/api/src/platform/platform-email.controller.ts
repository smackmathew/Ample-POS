import { BadGatewayException, Body, Controller, Get, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { NoTenant } from '../core/decorators';
import { MailError, Mailer } from '../core/mailer';
import { PlatformDb } from '../core/platform-db';
import { ZodPipe } from '../core/zod';
import { PlatformAccess } from './platform-access';
import { schema } from '@pos/db';

const emailBody = z.object({ email: z.string().trim().email().max(254) });

/**
 * Email health for Ample POS staff: how sending is set up, a test send that
 * shows the email service's own error, and confirming someone's address by
 * hand when confirmation emails can't get through.
 */
@Controller('platform/email')
@NoTenant()
export class PlatformEmailController {
  constructor(
    private readonly access: PlatformAccess,
    private readonly platform: PlatformDb,
    private readonly mailer: Mailer,
  ) {}

  @Get()
  async status() {
    await this.access.require();
    return this.mailer.status;
  }

  @Post('test')
  @HttpCode(200)
  async test(@Body(new ZodPipe(emailBody)) body: z.infer<typeof emailBody>) {
    const admin = await this.access.require();
    const status = this.mailer.status;
    if (status.mode === 'off') throw new BadGatewayException('Email is off: set RESEND_API_KEY and EMAIL_FROM on the server.');
    try {
      await this.mailer.send(body.email, 'Ample POS test email', 'This is a test email from the Ample POS super admin dashboard. If you can read it, email is working.');
    } catch (err) {
      throw new BadGatewayException(err instanceof MailError ? `Resend refused it: ${err.reason}` : 'The email service could not be reached.');
    }
    await this.platform.run((tx) => tx.insert(schema.platformAudit).values({ actorUserId: admin.userId, action: 'email.test_sent', tenantId: null, data: { to: body.email } }));
    return { sent: true, mode: status.mode };
  }

  /** Marks the account with this sign-in email as confirmed. */
  @Post('confirm')
  @HttpCode(200)
  async confirm(@Body(new ZodPipe(emailBody)) body: z.infer<typeof emailBody>) {
    const admin = await this.access.require();
    return this.platform.run(async (tx) => {
      const [row] = await tx.execute<{ user_id: string; already_confirmed: boolean }>(sql`select * from app_admin_confirm_email(${body.email})`);
      if (!row) throw new NotFoundException('No account signs in with that email');
      await tx.insert(schema.platformAudit).values({ actorUserId: admin.userId, action: 'email.confirmed_by_admin', tenantId: null, data: { email: body.email.toLowerCase(), userId: row.user_id } });
      return { confirmed: true, alreadyConfirmed: row.already_confirmed };
    });
  }
}

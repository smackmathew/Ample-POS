import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config';

export const MAIL_FETCH = Symbol('MAIL_FETCH');

/** The sender's default, which no email service will accept. */
export const PLACEHOLDER_FROM = 'Ample POS <no-reply@example.com>';

/** Sending failed; `reason` is the email service's own explanation, safe to show to admins. */
export class MailError extends Error {
  constructor(readonly reason: string) {
    super(`Email could not be sent: ${reason}`);
  }
}

/**
 * Transactional email through Resend's HTTP API. Off when RESEND_API_KEY is
 * unset, unless EMAIL_DEV_LOG prints messages to the log for local testing.
 */
@Injectable()
export class Mailer implements OnModuleInit {
  private readonly logger = new Logger('Mailer');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  onModuleInit() {
    if (this.config.RESEND_API_KEY && this.config.EMAIL_FROM === PLACEHOLDER_FROM) {
      this.logger.error('RESEND_API_KEY is set but EMAIL_FROM is not: emails will be rejected. Set EMAIL_FROM to an address on a domain verified in Resend.');
    }
  }

  /** How email is set up, for the super admin. */
  get status(): { mode: 'resend' | 'log' | 'off'; from: string; fromIsPlaceholder: boolean } {
    const mode = this.config.RESEND_API_KEY ? 'resend' : this.config.EMAIL_DEV_LOG === 'true' ? 'log' : 'off';
    return { mode, from: this.config.EMAIL_FROM, fromIsPlaceholder: this.config.EMAIL_FROM === PLACEHOLDER_FROM };
  }

  get enabled(): boolean {
    return Boolean(this.config.RESEND_API_KEY) || this.config.EMAIL_DEV_LOG === 'true';
  }

  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    if (!this.config.RESEND_API_KEY) {
      this.logger.log(`[dev email] to ${to}: ${subject}\n${text}`);
      return;
    }
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.config.EMAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let reason = `the email service answered ${res.status}`;
      try {
        const message = (JSON.parse(raw) as { message?: unknown }).message;
        if (typeof message === 'string' && message) reason = message;
      } catch {
        // Not JSON; keep the status.
      }
      this.logger.error(`Email to ${to.replace(/^(.).*(@.*)$/, '$1…$2')} failed: ${res.status} ${raw}`);
      throw new MailError(reason);
    }
  }
}

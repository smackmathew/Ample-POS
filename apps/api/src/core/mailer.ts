import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config';

export const MAIL_FETCH = Symbol('MAIL_FETCH');

/**
 * Transactional email through Resend's HTTP API. Off when RESEND_API_KEY is
 * unset, unless EMAIL_DEV_LOG prints messages to the log for local testing.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger('Mailer');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

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
      this.logger.error(`Email to ${to.replace(/^(.).*(@.*)$/, '$1…$2')} failed: ${res.status} ${await res.text().catch(() => '')}`);
      throw new Error('Email could not be sent');
    }
  }
}

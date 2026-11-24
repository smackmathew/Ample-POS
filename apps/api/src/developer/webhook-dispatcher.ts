import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { SECRET_BOX, type SecretBox } from '../core/secrets';
import { OutboxWorker } from '../worker/outbox.worker';
import { openWebhookSecret } from './webhook-secret';

export const WEBHOOK_FETCH = Symbol('WEBHOOK_FETCH');
export type WebhookFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

/** After this many failed attempts (about a day of retries) a delivery is marked failed. */
export const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, like Stripe's. */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/**
 * Sends queued webhook deliveries (see ApiEvents) every worker tick: signed
 * POSTs, retried with backoff on any non-2xx answer or network error.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit {
  private readonly logger = new Logger('Webhooks');

  constructor(
    private readonly db: Db,
    private readonly worker: OutboxWorker,
    @Inject(SECRET_BOX) private readonly box: SecretBox | null,
    @Inject(WEBHOOK_FETCH) private readonly send: WebhookFetch,
  ) {}

  onModuleInit() {
    this.worker.every('webhooks', 0, () => this.deliverDue().then(() => undefined));
  }

  /** Sends everything that's due; returns how many were attempted. */
  async deliverDue(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.db.pool.execute<{ id: number; url: string; secret: string; type: string; body: unknown; attempts: number }>(
        sql`select * from app_claim_webhook_deliveries(${20}, ${60})`,
      );
      if (!batch.length) return total;
      await Promise.all(batch.map((d) => this.deliver(d)));
      total += batch.length;
    }
  }

  private async deliver(d: { id: number; url: string; secret: string; type: string; body: unknown; attempts: number }) {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const body = JSON.stringify(d.body);
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await this.send(d.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AmplePOS-Webhooks/1.0',
          'Ample-Event-Id': String((d.body as { id?: string }).id ?? ''),
          'Ample-Event-Type': d.type,
          'Ample-Signature': signWebhook(openWebhookSecret(this.box, d.secret), body, timestamp),
        },
        body,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `Responded ${res.status}`;
    } catch (err) {
      error = (err as Error).message || 'Request failed';
    }
    if (error) this.logger.warn(`Delivery #${d.id} (${d.type}) attempt ${d.attempts} to ${new URL(d.url).host} failed: ${error}`);
    await this.db.pool.execute(sql`select app_finish_webhook_delivery(${d.id}, ${status}, ${error}, ${MAX_ATTEMPTS})`);
  }
}

/**
 * The real sender: refuses addresses on private networks (so a webhook URL
 * can't be used to reach Ample POS's own infrastructure), doesn't follow
 * redirects, and gives up after 10 seconds.
 */
export function safeWebhookFetch(config: AppConfig): WebhookFetch {
  return async (url, init) => {
    const { hostname } = new URL(url);
    if (config.WEBHOOK_ALLOW_PRIVATE !== 'true') {
      const host = hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
      if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('Webhook address is on a private network');
    }
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  };
}

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

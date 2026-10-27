import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/database';
import { runAsSystem } from '../core/system-context';

export type OutboxHandler = (payload: Record<string, unknown>, event: { id: number; topic: string; attempts: number }) => Promise<void>;

/** After this many attempts failures are logged as errors; retries continue hourly. */
const LOUD_AFTER_ATTEMPTS = 12;
const LEASE_SECONDS = 120;

/**
 * Delivers outbox events written by request transactions. Each event is
 * handled in its own system transaction for its business; failures are retried
 * with exponential backoff capped at an hour (see app_finish_outbox). Also
 * runs scheduled jobs such as store reconciliation.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxWorker');
  private readonly handlers = new Map<string, OutboxHandler[]>();
  private readonly scheduled: { name: string; everyMs: number; run: () => Promise<void>; lastRun: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  on(topics: string[], handler: OutboxHandler): void {
    for (const t of topics) this.handlers.set(t, [...(this.handlers.get(t) ?? []), handler]);
  }

  every(name: string, everyMs: number, run: () => Promise<void>): void {
    this.scheduled.push({ name, everyMs, run, lastRun: Date.now() });
  }

  onApplicationBootstrap() {
    if (this.config.WORKER_ENABLED !== 'true') return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.OUTBOX_POLL_MS);
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private async tick() {
    await this.runOnce();
    for (const job of this.scheduled) {
      if (Date.now() - job.lastRun < job.everyMs) continue;
      job.lastRun = Date.now();
      await job.run().catch((err) => this.logger.error(`${job.name} failed: ${(err as Error).message}`));
    }
  }

  /** Processes due events until none are left; returns how many were handled. Safe to call concurrently. */
  runOnce(): Promise<number> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.db.pool.execute<{ id: number; tenant_id: string; topic: string; payload: Record<string, unknown>; attempts: number }>(
        sql`select * from app_claim_outbox(${20}, ${LEASE_SECONDS})`,
      );
      if (!batch.length) return total;
      for (const event of batch) {
        const handlers = this.handlers.get(event.topic) ?? [];
        let error: string | null = null;
        try {
          for (const handler of handlers) {
            await runAsSystem(this.db, event.tenant_id, () => handler(event.payload, { id: Number(event.id), topic: event.topic, attempts: event.attempts }));
          }
        } catch (err) {
          error = (err as Error).message || 'Unknown error';
          const level = event.attempts >= LOUD_AFTER_ATTEMPTS ? 'error' : 'warn';
          this.logger[level](`${event.topic} #${event.id} attempt ${event.attempts} failed: ${error}`);
        }
        // Success marks it delivered; failure keeps the error and schedules a retry (backoff capped at an hour).
        await this.db.pool.execute(sql`select app_finish_outbox(${event.id}, ${error})`);
        total++;
      }
    }
  }
}

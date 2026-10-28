import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { Db } from '../../core/database';
import { runAsSystem } from '../../core/system-context';
import { OutboxWorker } from '../../worker/outbox.worker';
import { ShopifySyncService, STOCK_TOPICS, variantIdsIn } from './shopify-sync.service';

/** Background work for Shopify: push stock after it changes, handle webhooks, reconcile on a schedule. */
@Injectable()
export class ShopifyJobs implements OnModuleInit {
  private readonly logger = new Logger('ShopifyJobs');

  constructor(
    private readonly worker: OutboxWorker,
    private readonly sync: ShopifySyncService,
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.worker.on(STOCK_TOPICS, async (payload) => {
      const result = await this.sync.pushInventory(variantIdsIn(payload));
      // A conflict usually means an online order we haven't recorded yet; retry shortly.
      if (result.conflicts) throw new Error(`${result.conflicts} stock levels changed in Shopify meanwhile; will retry`);
    });

    this.worker.on(['shopify.webhook'], async (payload) => {
      const { topic, resourceId } = payload as { topic: string; resourceId: string | null };
      if (topic === 'app/uninstalled') return this.sync.markUninstalled();
      if (!resourceId || !(await this.sync.connection())) return;
      if (topic.startsWith('products/')) return this.sync.importProduct(resourceId);
      if (topic.startsWith('orders/')) return this.sync.ingestOrder(resourceId);
    });

    this.worker.every('shopify-reconcile', this.config.RECONCILE_INTERVAL_MS, () => this.reconcileAll());
  }

  async reconcileAll() {
    const connections = await this.db.pool.execute<{ id: string; tenant_id: string }>(sql`select * from app_active_connections() where provider = 'shopify'`);
    for (const c of connections) {
      await runAsSystem(this.db, c.tenant_id, () => this.sync.reconcile()).catch((err) =>
        this.logger.warn(`Reconcile failed for connection ${c.id}: ${(err as Error).message}`),
      );
    }
  }
}

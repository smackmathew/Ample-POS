import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxWorker } from '../worker/outbox.worker';
import { BillingService } from './billing.service';

/** Changes that alter what a business should be billed for. */
export const BILLING_TOPICS = ['module.enabled', 'module.disabled', 'location.created', 'location.updated', 'billing.status_changed'];

/** Keeps each subscription's items in step with the tools and locations in use. */
@Injectable()
export class BillingJobs implements OnModuleInit {
  constructor(
    private readonly worker: OutboxWorker,
    private readonly billing: BillingService,
  ) {}

  onModuleInit() {
    this.worker.on(BILLING_TOPICS, async () => {
      await this.billing.syncItems();
    });
  }
}

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createDb, PLATFORM_ROLE, type DbHandle, type Transaction } from '@pos/db';
import { APP_CONFIG, type AppConfig } from './config';

/**
 * The super admin dashboard's own connection, as the pos_platform role: it
 * reads every business but can only change platform controls (see migration
 * 0019). Only platform controllers use it, after checking the admin.
 */
@Injectable()
export class PlatformDb implements OnApplicationShutdown {
  private handle: DbHandle | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get url(): string {
    if (this.config.PLATFORM_DATABASE_URL) return this.config.PLATFORM_DATABASE_URL;
    const url = new URL(this.config.DATABASE_URL);
    url.username = PLATFORM_ROLE;
    return url.toString();
  }

  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.handle ??= createDb(this.url, { max: 3 });
    return this.handle.db.transaction(fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle?.close();
  }
}

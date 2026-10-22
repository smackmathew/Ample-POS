import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Database, type DbHandle, type Transaction } from '@pos/db';
import { currentContext } from './request-context';

export const DB_HANDLE = Symbol('DB_HANDLE');

@Injectable()
export class Db implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  /** Pool access outside a request transaction. RLS settings are not applied. */
  get pool(): Database {
    return this.handle.db;
  }

  /** The current request's transaction, with app.user_id / app.tenant_id set. */
  get tx(): Transaction {
    return currentContext().tx;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

export function dbHandleFactory(url: string): DbHandle {
  return createDb(url);
}

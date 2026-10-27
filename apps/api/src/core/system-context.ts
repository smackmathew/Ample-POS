import { sql } from 'drizzle-orm';
import type { Db } from './database';
import { runWithContext } from './request-context';

/**
 * Runs `fn` in a transaction scoped to one business with no signed-in user,
 * for work triggered by the system itself (e.g. payment webhooks). RLS still
 * applies; audit rows record no actor.
 */
export function runAsSystem<T>(db: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  return db.pool.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return runWithContext(
      { user: null, tx, device: null, tenant: { tenantId, membershipId: '', roleId: '', roleKey: 'system', permissions: ['*'] } },
      fn,
    );
  });
}

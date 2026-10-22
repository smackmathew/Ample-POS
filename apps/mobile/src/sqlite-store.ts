import type { EntryStore, LocalEntry } from '@pos/sync';
import { database } from './db';

interface Row {
  id: string;
  count_id: string;
  variant_id: string;
  label: string;
  quantity: number;
  counted_at: string;
  state: LocalEntry['state'];
  voided: number;
  void_state: LocalEntry['voidState'];
  error: string | null;
}

const toEntry = (r: Row): LocalEntry => ({
  id: r.id,
  countId: r.count_id,
  variantId: r.variant_id,
  label: r.label,
  quantity: r.quantity,
  countedAt: r.counted_at,
  state: r.state,
  voided: r.voided === 1,
  voidState: r.void_state,
  error: r.error,
});

const COLUMNS: Record<string, string> = { state: 'state', voided: 'voided', voidState: 'void_state', error: 'error' };

/** Persists the count queue so scans survive the app being closed or the phone restarting. */
export class SqliteEntryStore implements EntryStore {
  async add(e: LocalEntry): Promise<void> {
    await (await database()).runAsync(
      `insert or ignore into entries (id, count_id, variant_id, label, quantity, counted_at, state, voided, void_state, error)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, e.countId, e.variantId, e.label, e.quantity, e.countedAt, e.state, e.voided ? 1 : 0, e.voidState, e.error,
    );
  }

  async get(id: string): Promise<LocalEntry | null> {
    const row = await (await database()).getFirstAsync<Row>('select * from entries where id = ?', id);
    return row ? toEntry(row) : null;
  }

  async list(countId: string): Promise<LocalEntry[]> {
    const rows = await (await database()).getAllAsync<Row>('select * from entries where count_id = ? order by counted_at, id', countId);
    return rows.map(toEntry);
  }

  async pendingAdds(limit: number): Promise<LocalEntry[]> {
    const rows = await (await database()).getAllAsync<Row>(
      `select * from entries where state = 'pending' and voided = 0 order by counted_at, id limit ?`,
      limit,
    );
    return rows.map(toEntry);
  }

  async pendingVoids(limit: number): Promise<LocalEntry[]> {
    const rows = await (await database()).getAllAsync<Row>(
      `select * from entries where voided = 1 and void_state = 'pending' order by counted_at, id limit ?`,
      limit,
    );
    return rows.map(toEntry);
  }

  async update(ids: string[], patch: Partial<Pick<LocalEntry, 'state' | 'voided' | 'voidState' | 'error'>>): Promise<void> {
    const sets = Object.entries(patch).filter(([k]) => k in COLUMNS);
    if (!ids.length || !sets.length) return;
    const assignments = sets.map(([k]) => `${COLUMNS[k]} = ?`).join(', ');
    const values = sets.map(([k, v]) => (k === 'voided' ? (v ? 1 : 0) : (v as string | null)));
    const db = await database();
    await db.withTransactionAsync(async () => {
      for (const id of ids) await db.runAsync(`update entries set ${assignments} where id = ?`, ...values, id);
    });
  }
}

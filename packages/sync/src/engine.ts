import { ApiError, NetworkError, type ApiClient } from './api-client';

/**
 * A count entry recorded on the device. It is the unit of sync: the server
 * de-duplicates by `id`, so resending after a lost response is safe.
 */
export interface LocalEntry {
  id: string;
  countId: string;
  variantId: string;
  /** Display label captured at scan time so the list works offline. */
  label: string;
  quantity: number;
  countedAt: string;
  /** pending: not yet accepted by the server. failed: the server refused it for good. */
  state: 'pending' | 'synced' | 'failed';
  voided: boolean;
  /** Only meaningful for voided entries that had already synced. */
  voidState: 'none' | 'pending' | 'synced' | 'failed';
  error: string | null;
}

export interface EntryStore {
  add(entry: LocalEntry): Promise<void>;
  get(id: string): Promise<LocalEntry | null>;
  list(countId: string): Promise<LocalEntry[]>;
  /** Entries to send: pending, not voided, oldest first. */
  pendingAdds(limit: number): Promise<LocalEntry[]>;
  /** Synced entries voided locally whose void has not reached the server. */
  pendingVoids(limit: number): Promise<LocalEntry[]>;
  update(ids: string[], patch: Partial<Pick<LocalEntry, 'state' | 'voided' | 'voidState' | 'error'>>): Promise<void>;
}

export type FlushStop = 'offline' | 'unauthorized';

export interface FlushResult {
  sent: number;
  failed: number;
  /** Why the flush stopped early, if it did. Remaining work stays queued. */
  stopped?: FlushStop;
}

export interface SyncStatus {
  pending: number;
  failed: number;
}

const BATCH = 500;

const isPermanent = (err: unknown) =>
  err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429;

/** Queues count entries locally and delivers them when the API is reachable. */
export class SyncEngine {
  private inflight: Promise<FlushResult> | null = null;

  constructor(
    private readonly store: EntryStore,
    private api: ApiClient,
  ) {}

  setApi(api: ApiClient): void {
    this.api = api;
  }

  async record(input: Pick<LocalEntry, 'id' | 'countId' | 'variantId' | 'label' | 'quantity'> & { countedAt?: string }): Promise<LocalEntry> {
    const entry: LocalEntry = {
      ...input,
      countedAt: input.countedAt ?? new Date().toISOString(),
      state: 'pending',
      voided: false,
      voidState: 'none',
      error: null,
    };
    await this.store.add(entry);
    return entry;
  }

  /** Everything recorded on this device for a count, oldest first. */
  entries(countId: string): Promise<LocalEntry[]> {
    return this.store.list(countId);
  }

  /** Undo an entry. If it never reached the server, it is simply never sent. */
  async void(id: string): Promise<void> {
    const entry = await this.store.get(id);
    if (!entry || entry.voided) return;
    await this.store.update([id], { voided: true, voidState: entry.state === 'synced' ? 'pending' : 'none' });
  }

  /** Sends queued work. Concurrent calls share one flush. */
  flush(): Promise<FlushResult> {
    this.inflight ??= this.doFlush().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doFlush(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, failed: 0 };

    for (;;) {
      const batch = await this.store.pendingAdds(BATCH);
      if (!batch.length) break;
      // One request per count, oldest count first.
      const countId = batch[0]!.countId;
      const group = batch.filter((e) => e.countId === countId);
      try {
        await this.api.post(`/inventory/counts/${countId}/entries`, {
          entries: group.map((e) => ({ id: e.id, variantId: e.variantId, quantity: e.quantity, countedAt: e.countedAt })),
        });
        await this.store.update(group.map((e) => e.id), { state: 'synced', error: null });
        result.sent += group.length;
      } catch (err) {
        const stop = this.stopReason(err);
        if (stop) return { ...result, stopped: stop };
        // e.g. the count was submitted or cancelled elsewhere, or an item was deleted.
        await this.store.update(group.map((e) => e.id), { state: 'failed', error: (err as Error).message });
        result.failed += group.length;
      }
    }

    for (;;) {
      const voids = await this.store.pendingVoids(BATCH);
      if (!voids.length) break;
      for (const entry of voids) {
        try {
          await this.api.post(`/inventory/counts/${entry.countId}/entries/${entry.id}/void`);
          await this.store.update([entry.id], { voidState: 'synced', error: null });
          result.sent++;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            // Already voided on the server (for example by a retry whose response was lost).
            await this.store.update([entry.id], { voidState: 'synced', error: null });
            continue;
          }
          const stop = this.stopReason(err);
          if (stop) return { ...result, stopped: stop };
          await this.store.update([entry.id], { voidState: 'failed', error: (err as Error).message });
          result.failed++;
        }
      }
    }
    return result;
  }

  private stopReason(err: unknown): FlushStop | null {
    if (err instanceof ApiError && err.status === 401) return 'unauthorized';
    if (err instanceof NetworkError || !isPermanent(err)) return 'offline';
    return null;
  }

  async status(countId?: string): Promise<SyncStatus> {
    const entries = countId ? await this.store.list(countId) : [...(await this.store.pendingAdds(10_000)), ...(await this.store.pendingVoids(10_000))];
    return {
      pending: entries.filter((e) => (e.state === 'pending' && !e.voided) || e.voidState === 'pending').length,
      failed: entries.filter((e) => (e.state === 'failed' && !e.voided) || e.voidState === 'failed').length,
    };
  }
}

/** EntryStore kept in memory; used in tests and as a reference for persistent stores. */
export class MemoryEntryStore implements EntryStore {
  private readonly entries = new Map<string, LocalEntry>();

  async add(entry: LocalEntry) {
    if (!this.entries.has(entry.id)) this.entries.set(entry.id, { ...entry });
  }

  async get(id: string) {
    const e = this.entries.get(id);
    return e ? { ...e } : null;
  }

  async list(countId: string) {
    return this.sorted().filter((e) => e.countId === countId);
  }

  async pendingAdds(limit: number) {
    return this.sorted()
      .filter((e) => e.state === 'pending' && !e.voided)
      .slice(0, limit);
  }

  async pendingVoids(limit: number) {
    return this.sorted()
      .filter((e) => e.voided && e.voidState === 'pending')
      .slice(0, limit);
  }

  async update(ids: string[], patch: Partial<LocalEntry>) {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) this.entries.set(id, { ...e, ...patch });
    }
  }

  private sorted() {
    return [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) => a.countedAt.localeCompare(b.countedAt) || a.id.localeCompare(b.id));
  }
}

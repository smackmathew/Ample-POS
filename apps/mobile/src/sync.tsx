import { SyncEngine, type FlushResult } from '@pos/sync';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';
import { SqliteEntryStore } from './sqlite-store';

interface SyncValue {
  engine: SyncEngine;
  /** Result of the most recent flush, for the status banner. */
  last: (FlushResult & { at: Date }) | null;
  /** Increments whenever local entries may have changed. */
  version: number;
  flush(): Promise<FlushResult>;
  touch(): void;
}

const SyncContext = createContext<SyncValue | null>(null);
const INTERVAL_MS = 15_000;

/** Owns the one sync engine and flushes it periodically and when the app returns to the foreground. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { api, session } = useSession();
  const [engine] = useState(() => new SyncEngine(new SqliteEntryStore(), api));
  const [last, setLast] = useState<SyncValue['last']>(null);
  const [version, setVersion] = useState(0);
  const paired = Boolean(session.token && session.tenantId && session.deviceCredential);

  useEffect(() => engine.setApi(api), [engine, api]);

  const flush = useCallback(async () => {
    const result = await engine.flush();
    setLast({ ...result, at: new Date() });
    if (result.sent || result.failed) setVersion((v) => v + 1);
    return result;
  }, [engine]);

  useEffect(() => {
    if (!paired) return;
    void flush();
    const timer = setInterval(() => void flush(), INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => state === 'active' && void flush());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [paired, flush]);

  const value = useMemo<SyncValue>(
    () => ({ engine, last, version, flush, touch: () => setVersion((v) => v + 1) }),
    [engine, last, version, flush],
  );
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error('useSync must be used inside SyncProvider');
  return value;
}

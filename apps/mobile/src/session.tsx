import { ApiClient } from '@pos/sync';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearLocalData } from './db';

export interface Session {
  apiUrl: string;
  token?: string;
  email?: string;
  tenantId?: string;
  tenantName?: string;
  /** "<deviceId>.<secret>" from the pairing QR code. Stored only in the secure keychain. */
  deviceCredential?: string;
  /** kind: a register sells; a handheld counts. Sessions paired before registers existed have none (handheld). */
  device?: { id: string; name: string; kind?: 'register' | 'handheld' | 'kiosk'; locationId: string; locationName: string };
}

interface SessionValue {
  ready: boolean;
  session: Session;
  /** Client carrying whatever credentials the session has so far. */
  api: ApiClient;
  update(patch: Partial<Session>): Promise<void>;
  /** Forget the business and device (and their local data); keep the sign-in. */
  leaveBusiness(): Promise<void>;
  signOut(): Promise<void>;
}

const KEY = 'ample-pos.session';
const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ defaultApiUrl, children }: { defaultApiUrl: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session>({ apiUrl: defaultApiUrl });

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((raw) => raw && setSession(JSON.parse(raw) as Session))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const save = useCallback(async (next: Session) => {
    setSession(next);
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      session,
      api: new ApiClient({
        baseUrl: session.apiUrl,
        token: session.token,
        tenantId: session.tenantId,
        deviceCredential: session.deviceCredential,
      }),
      update: (patch) => save({ ...session, ...patch }),
      leaveBusiness: async () => {
        await clearLocalData();
        await save({ apiUrl: session.apiUrl, token: session.token, email: session.email });
      },
      signOut: async () => {
        await clearLocalData();
        await save({ apiUrl: session.apiUrl });
      },
    }),
    [ready, session, save],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

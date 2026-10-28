import type { CardReader, CollectResult } from '@pos/sync';
import type { Reader, StripeError } from '@stripe/stripe-terminal-react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NativeModules, Platform } from 'react-native';
import { useSession } from './session';

export type DiscoveryMethod = 'tapToPay' | 'bluetoothScan';

export interface TerminalValue {
  /** False in Expo Go and on the web: the reader SDK is only in the Ample POS app build. */
  available: boolean;
  connected: Reader.Type | null;
  discovered: Reader.Type[];
  discovering: boolean;
  /** What the reader is asking for ("Insert or tap card") or the last problem. */
  message: string | null;
  discover(method: DiscoveryMethod, simulated: boolean): Promise<void>;
  cancelDiscovery(): Promise<void>;
  connect(reader: Reader.Type): Promise<void>;
  disconnect(): Promise<void>;
  /** Drives the connected reader for one payment; null until a reader is connected. */
  cardReader: CardReader | null;
}

const TerminalContext = createContext<TerminalValue | null>(null);

/** The SDK is a native module; Expo Go doesn't include it. */
const SDK_AVAILABLE = Platform.OS !== 'web' && NativeModules.StripeTerminalReactNative != null;

const unavailable: TerminalValue = {
  available: false,
  connected: null,
  discovered: [],
  discovering: false,
  message: null,
  discover: async () => {},
  cancelDiscovery: async () => {},
  connect: async () => {},
  disconnect: async () => {},
  cardReader: null,
};

/**
 * Card readers through Stripe Terminal. Connection tokens come from our API
 * (scoped to the register's store), so the app never holds a Stripe key.
 */
export function TerminalProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const isRegister = session.device?.kind === 'register' && Boolean(session.deviceCredential);
  if (!SDK_AVAILABLE || !isRegister) return <TerminalContext.Provider value={unavailable}>{children}</TerminalContext.Provider>;
  return <StripeTerminalRoot>{children}</StripeTerminalRoot>;
}

function StripeTerminalRoot({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const apiRef = useRef(api);
  apiRef.current = api;
  // Remembered from the token response: readers connect to our store's Stripe location.
  const locationRef = useRef<string | null>(null);
  // Loaded only when the native module exists, so Expo Go never evaluates it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeTerminalProvider } = require('@stripe/stripe-terminal-react-native') as typeof import('@stripe/stripe-terminal-react-native');
  const tokenProvider = useCallback(async () => {
    const res = await apiRef.current.post<{ secret: string; locationRef: string }>('/terminal/connection-token');
    locationRef.current = res.locationRef;
    return res.secret;
  }, []);
  return (
    <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="error">
      <ConnectedTerminal locationRef={locationRef}>{children}</ConnectedTerminal>
    </StripeTerminalProvider>
  );
}

function ConnectedTerminal({ children, locationRef }: { children: ReactNode; locationRef: { current: string | null } }) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('@stripe/stripe-terminal-react-native') as typeof import('@stripe/stripe-terminal-react-native');
  const { api } = useSession();
  const [discovered, setDiscovered] = useState<Reader.Type[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const method = useRef<DiscoveryMethod>('bluetoothScan');

  const terminal = sdk.useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => setDiscovered(readers),
    onFinishDiscoveringReaders: () => setDiscovering(false),
    onDidRequestReaderDisplayMessage: (m) => setMessage(readerText(String(m))),
    onDidRequestReaderInput: (inputs) => setMessage(`Customer: ${inputs.map((i) => readerText(String(i))).join(' or ')}`),
    onDidDisconnect: () => setMessage('The card reader disconnected.'),
  });
  const { initialize, isInitialized, connectedReader } = terminal;

  useEffect(() => {
    if (!isInitialized) void initialize().then(({ error }) => error && setMessage(error.message));
  }, [initialize, isInitialized]);

  const discover = useCallback(
    async (m: DiscoveryMethod, simulated: boolean) => {
      setMessage(null);
      setDiscovered([]);
      if (Platform.OS === 'android' && m === 'bluetoothScan') {
        const { error } = await sdk.requestNeededAndroidPermissions();
        if (error) return setMessage('Allow Bluetooth and location access to find card readers.');
      }
      method.current = m;
      setDiscovering(true);
      const { error } = await terminal.discoverReaders({ discoveryMethod: m, simulated } as Parameters<typeof terminal.discoverReaders>[0]);
      setDiscovering(false);
      if (error && error.code !== sdk.ErrorCode.CANCELED) setMessage(error.message);
    },
    [sdk, terminal],
  );

  const connect = useCallback(
    async (reader: Reader.Type) => {
      setMessage(null);
      // The token request remembers our store's Stripe location; fetch one if we haven't yet.
      if (!locationRef.current) locationRef.current = (await api.post<{ locationRef: string }>('/terminal/connection-token')).locationRef;
      const { error } = await terminal.connectReader(
        { discoveryMethod: method.current, reader, locationId: locationRef.current!, autoReconnectOnUnexpectedDisconnect: true } as Parameters<typeof terminal.connectReader>[0],
      );
      if (error) setMessage(error.message);
      else setDiscovered([]);
    },
    [api, locationRef, terminal],
  );

  const cardReader = useMemo<CardReader | null>(() => {
    if (!connectedReader) return null;
    return {
      async collect(clientSecret: string): Promise<CollectResult> {
        setMessage(null);
        const retrieved = await terminal.retrievePaymentIntent(clientSecret);
        if (retrieved.error || !retrieved.paymentIntent) return failure(retrieved.error, sdk);
        const collected = await terminal.collectPaymentMethod({ paymentIntent: retrieved.paymentIntent });
        if (collected.error || !collected.paymentIntent) return failure(collected.error, sdk);
        const confirmed = await terminal.confirmPaymentIntent({ paymentIntent: collected.paymentIntent });
        if (confirmed.error) return failure(confirmed.error, sdk);
        return { status: 'approved' };
      },
      async cancelCollect() {
        await terminal.cancelCollectPaymentMethod();
      },
    };
  }, [connectedReader, sdk, terminal]);

  const value = useMemo<TerminalValue>(
    () => ({
      available: true,
      connected: connectedReader ?? null,
      discovered,
      discovering,
      message,
      discover,
      cancelDiscovery: async () => {
        await terminal.cancelDiscovering();
        setDiscovering(false);
      },
      connect,
      disconnect: async () => {
        await terminal.disconnectReader();
      },
      cardReader,
    }),
    [cardReader, connect, connectedReader, discover, discovered, discovering, message, terminal],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

function failure(error: StripeError | undefined, sdk: typeof import('@stripe/stripe-terminal-react-native')): CollectResult {
  const message = error?.message ?? 'The reader did not respond';
  if (error?.code === sdk.ErrorCode.CANCELED) return { status: 'canceled', message };
  if (error?.code === sdk.ErrorCode.DECLINED_BY_STRIPE_API || error?.code === sdk.ErrorCode.DECLINED_BY_READER) return { status: 'declined', message };
  return { status: 'error', message };
}

/** "insertOrSwipeCard" → "insert or swipe card". */
function readerText(code: string): string {
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function useTerminal(): TerminalValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error('useTerminal must be used inside TerminalProvider');
  return value;
}

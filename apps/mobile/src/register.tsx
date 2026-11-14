import { Cart, CatalogIndex, Checkout, type Customer, type RegisterSession, type TerminalConfig } from '@pos/sync';
import { randomUUID } from 'expo-crypto';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadCatalog, refreshCatalog } from './catalog-cache';
import { useSession } from './session';

interface RegisterValue {
  checkout: Checkout;
  newId(): string;
  catalog: CatalogIndex;
  catalogSyncedAt: string | null;
  refreshCatalog(): Promise<void>;
  /** undefined while loading; null when no register is open on this device. */
  register: RegisterSession | null | undefined;
  reloadRegister(): Promise<void>;
  terminal: TerminalConfig | null;
  cart: Cart;
  setCart(cart: Cart): void;
  /** Made once per cart, so a retried "Charge" never creates a second sale. */
  saleId: string;
  /** Clears the cart and starts a new sale id. */
  newSale(): void;
  /** Keeps the cart but uses a new sale id, after the previous sale for it was voided. */
  reopenCart(): void;
  /** The Customers tool is on and this person may use it. */
  customersOn: boolean;
  /** The Gift cards tool is on. */
  giftCardsOn: boolean;
  /** The customer for the sale being rung up. */
  customer: Customer | null;
  setCustomer(customer: Customer | null): void;
  error: string | null;
}

const RegisterContext = createContext<RegisterValue | null>(null);

/** State for selling on a paired register: the open register, catalog and cart. */
export function RegisterProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const checkout = useMemo(() => new Checkout(api, randomUUID), [api]);
  const [catalog, setCatalog] = useState(() => new CatalogIndex([]));
  const [catalogSyncedAt, setCatalogSyncedAt] = useState<string | null>(null);
  const [register, setRegister] = useState<RegisterSession | null | undefined>(undefined);
  const [terminal, setTerminal] = useState<TerminalConfig | null>(null);
  const [cart, setCart] = useState(Cart.empty);
  const [saleId, setSaleId] = useState(randomUUID);
  const [error, setError] = useState<string | null>(null);
  const [customersOn, setCustomersOn] = useState(false);
  const [giftCardsOn, setGiftCardsOn] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);

  const reloadRegister = useCallback(async () => {
    try {
      const [current, config] = await Promise.all([checkout.currentRegister(), checkout.terminalConfig()]);
      setRegister(current.session);
      setTerminal(config);
      setError(null);
      // Optional: the register works the same without customers.
      void checkout.customersAvailable().then(setCustomersOn, () => setCustomersOn(false));
      void checkout.toolEnabled('gift-cards').then(setGiftCardsOn, () => setGiftCardsOn(false));
    } catch (err) {
      setError((err as Error).message);
      setRegister((r) => (r === undefined ? null : r));
    }
  }, [checkout]);

  const refresh = useCallback(async () => {
    const index = await refreshCatalog(api);
    setCatalog(index);
    setCatalogSyncedAt(new Date().toISOString());
  }, [api]);

  useEffect(() => {
    void reloadRegister();
    // Show the saved catalog at once, then fetch the latest prices.
    void loadCatalog().then(({ index, syncedAt }) => {
      setCatalog(index);
      setCatalogSyncedAt(syncedAt);
    });
    void refresh().catch(() => {});
  }, [reloadRegister, refresh]);

  const value = useMemo<RegisterValue>(
    () => ({
      checkout,
      newId: randomUUID,
      catalog,
      catalogSyncedAt,
      refreshCatalog: refresh,
      register,
      reloadRegister,
      terminal,
      cart,
      setCart,
      saleId,
      newSale: () => {
        setCart(Cart.empty());
        setCustomer(null);
        setSaleId(randomUUID());
      },
      reopenCart: () => setSaleId(randomUUID()),
      customersOn,
      giftCardsOn,
      customer,
      setCustomer,
      error,
    }),
    [checkout, catalog, catalogSyncedAt, refresh, register, reloadRegister, terminal, cart, saleId, customersOn, giftCardsOn, customer, error],
  );
  return <RegisterContext.Provider value={value}>{children}</RegisterContext.Provider>;
}

export function useRegister(): RegisterValue {
  const value = useContext(RegisterContext);
  if (!value) throw new Error('useRegister must be used inside RegisterProvider');
  return value;
}

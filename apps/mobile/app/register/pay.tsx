import type { Receipt } from '@pos/receipts';
import { receiptHtml } from '@pos/receipts';
import { formatMoney, parseMoney, quickCashAmounts, type CardOutcome, type Sale } from '@pos/sync';
import * as Print from 'expo-print';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, View } from 'react-native';
import { useRegister } from '@/register';
import { useSession } from '@/session';
import { useTerminal } from '@/terminal';
import { Button, colors, ErrorText, Field, styles } from '@/ui';

/** Takes payment for the sale made from the cart: cash, card, or both. */
export default function Pay() {
  const { checkout, saleId, newSale, reopenCart, terminal, newId } = useRegister();
  const reader = useTerminal();
  const [sale, setSale] = useState<Sale | null>(null);
  const [tendered, setTendered] = useState('');
  const [change, setChange] = useState<number | null>(null);
  // Reused after a decline so "Try again" resumes the same card payment.
  const [cardPaymentId, setCardPaymentId] = useState(newId);
  const [busy, setBusy] = useState<'cash' | 'card' | 'void' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSale(await checkout.getSale(saleId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [checkout, saleId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!sale) {
    return (
      <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        {error ? <ErrorText>{error}</ErrorText> : <ActivityIndicator />}
      </View>
    );
  }

  const money = (minor: number) => formatMoney(minor, sale.currency);
  const finish = () => {
    newSale();
    router.dismissTo('/register');
  };

  if (sale.status === 'completed') return <Paid sale={sale} change={change} onNewSale={finish} />;

  const run = async (kind: 'cash' | 'card', fn: () => Promise<void>) => {
    setBusy(kind);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const takeCash = (amount: number) =>
    run('cash', async () => {
      const res = await checkout.payCash(sale.id, amount);
      setSale(res.sale);
      setChange((c) => (c ?? 0) + res.changeMinor);
      setTendered('');
    });

  const onCard = (outcome: CardOutcome) => {
    setSale(outcome.sale);
    if (outcome.status === 'retry') {
      setError(outcome.message);
    } else {
      // Paid or released: the next card attempt is a new payment.
      setCardPaymentId(newId());
      if (outcome.status === 'canceled') setError('Card payment canceled. Nothing was charged.');
    }
  };

  const chargeCard = () =>
    run('card', async () => {
      onCard(await checkout.payCard(sale.id, reader.cardReader!, cardPaymentId));
    });

  const simulateCard = (outcome: 'approve' | 'decline') =>
    run('card', async () => {
      onCard(await checkout.simulateCard(sale.id, outcome, cardPaymentId));
    });

  const voidAnd = (then: () => void) => async () => {
    setBusy('void');
    try {
      await checkout.voidSale(sale.id);
      then();
    } catch (err) {
      Alert.alert('Could not cancel the sale', (err as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  };
  const nothingTaken = sale.paidMinor === 0;
  const cashMinor = parseMoney(tendered);

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ headerBackVisible: false, gestureEnabled: false }} />
      <View style={[styles.card, { gap: 4 }]}>
        {sale.lines.map((l) => (
          <View key={l.id} style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={{ flex: 1 }}>
              {l.quantity} × {l.description}
            </Text>
            <Text>{money(l.totalMinor)}</Text>
          </View>
        ))}
        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
        <Line label="Subtotal" value={money(sale.subtotalMinor)} />
        {sale.discountMinor > 0 && <Line label="Discounts" value={`−${money(sale.discountMinor)}`} />}
        <Line label="Tax" value={money(sale.taxMinor)} />
        <Line label="Total" value={money(sale.totalMinor)} bold />
        {sale.paidMinor > 0 && <Line label="Paid" value={money(sale.paidMinor)} />}
      </View>

      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.title}>Due</Text>
        <Text style={{ fontSize: 28, fontWeight: '700' }}>{money(sale.dueMinor + sale.pendingMinor)}</Text>
      </View>
      <ErrorText>{error}</ErrorText>

      <Text style={styles.label}>CARD</Text>
      {terminal?.readers === 'simulated' ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.muted}>Test mode: no reader. Choose what the customer’s card does.</Text>
          <View style={styles.row}>
            <Button title="Approve card" onPress={() => simulateCard('approve')} busy={busy === 'card'} disabled={!!busy} style={{ flex: 1 }} />
            <Button title="Decline" variant="secondary" onPress={() => simulateCard('decline')} disabled={!!busy} style={{ flex: 1 }} />
          </View>
        </View>
      ) : !terminal?.location.ready ? (
        <Text style={{ color: colors.warn }}>{terminal?.location.problem}</Text>
      ) : reader.cardReader ? (
        <View style={{ gap: 8 }}>
          <Button title={busy === 'card' ? 'Waiting for card…' : `Charge card ${money(sale.dueMinor + sale.pendingMinor)}`} onPress={chargeCard} disabled={!!busy} />
          {busy === 'card' && (
            <>
              {reader.message && <Text style={{ textAlign: 'center', fontSize: 16 }}>{reader.message}</Text>}
              <Button title="Cancel card" variant="secondary" onPress={() => void reader.cardReader?.cancelCollect()} />
            </>
          )}
        </View>
      ) : (
        <Button
          title={reader.available ? 'Connect a card reader' : 'Card readers need the Ample POS app build'}
          variant="secondary"
          disabled={!reader.available}
          onPress={() => router.push('/register/reader')}
        />
      )}

      <Text style={[styles.label, { marginTop: 8 }]}>CASH</Text>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        {quickCashAmounts(sale.dueMinor).map((amount) => (
          <Button key={amount} title={money(amount)} variant="secondary" onPress={() => takeCash(amount)} disabled={!!busy || sale.dueMinor === 0} />
        ))}
      </View>
      <View style={[styles.row, { alignItems: 'flex-end' }]}>
        <View style={{ flex: 1 }}>
          <Field label="Cash received" value={tendered} onChangeText={setTendered} keyboardType="decimal-pad" placeholder="0.00" />
        </View>
        <Button title="Take cash" onPress={() => cashMinor && takeCash(cashMinor)} busy={busy === 'cash'} disabled={!!busy || !cashMinor || sale.dueMinor === 0} />
      </View>
      {sale.dueMinor === 0 && sale.pendingMinor > 0 && <Text style={styles.muted}>A card payment is in progress. Finish or cancel it first.</Text>}

      <View style={{ height: 16 }} />
      {nothingTaken && (
        <Button
          title="Edit cart"
          variant="secondary"
          disabled={!!busy}
          onPress={voidAnd(() => {
            reopenCart();
            router.back();
          })}
        />
      )}
      {nothingTaken && (
        <Button
          title="Cancel sale"
          variant="danger"
          busy={busy === 'void'}
          onPress={() =>
            Alert.alert('Cancel this sale?', 'The cart will be cleared.', [
              { text: 'Keep', style: 'cancel' },
              { text: 'Cancel sale', style: 'destructive', onPress: voidAnd(finish) },
            ])
          }
        />
      )}
    </ScrollView>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={[styles.row, { justifyContent: 'space-between' }]}>
      <Text style={bold ? { fontWeight: '700', fontSize: 16 } : styles.muted}>{label}</Text>
      <Text style={bold ? { fontWeight: '700', fontSize: 16 } : undefined}>{value}</Text>
    </View>
  );
}

/** After payment: change due, then the receipt, printed or emailed. */
function Paid({ sale, change, onNewSale }: { sale: Sale; change: number | null; onNewSale: () => void }) {
  const { api } = useSession();
  const [email, setEmail] = useState(sale.customer?.email ?? '');
  const [busy, setBusy] = useState<'print' | 'email' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const money = (minor: number) => formatMoney(minor, sale.currency);

  const print = async () => {
    setBusy('print');
    setNote(null);
    try {
      const receipt = await api.get<Receipt>(`/sales/${sale.id}/receipt`);
      // The phone's own print service: AirPrint on iOS, Android printing (most receipt printers support one).
      await Print.printAsync({ html: receiptHtml(receipt) });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('email');
    setNote(null);
    try {
      await api.post(`/sales/${sale.id}/receipt/email`, { email: email.trim() });
      setNote({ ok: true, text: `Receipt sent to ${email.trim()}` });
      setEmail('');
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.screen, { alignItems: 'stretch' }]} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Paid', headerBackVisible: false, gestureEnabled: false }} />
      <View style={[styles.card, { alignItems: 'center', gap: 6, paddingVertical: 28 }]}>
        <Text style={{ fontSize: 16, color: colors.muted }}>Receipt #{sale.receiptNumber}</Text>
        <Text style={{ fontSize: 32, fontWeight: '700', color: colors.brand }}>{money(sale.totalMinor)}</Text>
        <Text style={styles.muted}>Paid in full</Text>
      </View>
      {change !== null && change > 0 && (
        <View style={[styles.card, { alignItems: 'center', gap: 4 }]}>
          <Text style={styles.muted}>Change due</Text>
          <Text style={{ fontSize: 40, fontWeight: '700' }}>{money(change)}</Text>
        </View>
      )}
      <Button title="Print receipt" variant="secondary" onPress={print} busy={busy === 'print'} disabled={busy !== null} />
      <View style={[styles.row, { alignItems: 'flex-end' }]}>
        <View style={{ flex: 1 }}>
          <Field label="Email receipt" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" placeholder="customer@example.com" />
        </View>
        <Button title="Send" variant="secondary" onPress={send} busy={busy === 'email'} disabled={busy !== null || !email.includes('@')} />
      </View>
      {note && <Text style={{ color: note.ok ? colors.brand : colors.danger }}>{note.text}</Text>}
      <Button title="New sale" onPress={onNewSale} />
    </ScrollView>
  );
}

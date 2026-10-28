import { formatMoney, parseMoney, type RegisterSummary } from '@pos/sync';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRegister } from '@/register';
import { Button, colors, ErrorText, Field, styles } from '@/ui';

/** End of shift: count the drawer and compare it with what the register expects. */
export default function CloseRegister() {
  const { checkout, register, reloadRegister, newSale } = useRegister();
  const [summary, setSummary] = useState<RegisterSummary | null>(null);
  const [closed, setClosed] = useState<RegisterSummary | null>(null);
  const [counted, setCounted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (register) void checkout.registerSummary(register.id).then(setSummary, (err: Error) => setError(err.message));
  }, [checkout, register]);

  if (closed) {
    const variance = closed.varianceMinor ?? 0;
    return (
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.title}>Register closed</Text>
        <View style={[styles.card, { gap: 4 }]}>
          <Row label="Expected cash" value={formatMoney(closed.totals.expectedCashMinor ?? 0)} />
          <Row label="Counted" value={formatMoney(closed.countedCashMinor ?? 0)} />
          <Row
            label={variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short'}
            value={formatMoney(Math.abs(variance))}
            color={variance === 0 ? colors.brand : colors.danger}
          />
        </View>
        <Button
          title="Done"
          onPress={async () => {
            newSale();
            await reloadRegister();
            router.dismissTo('/register');
          }}
        />
      </ScrollView>
    );
  }

  const close = async () => {
    const minor = parseMoney(counted);
    if (minor === null) return setError('Enter the cash counted in the drawer');
    setBusy(true);
    setError('');
    try {
      setClosed(await checkout.closeRegister(register!.id, minor));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {summary && (
        <View style={[styles.card, { gap: 4 }]}>
          <Row label="Sales" value={String(summary.totals.salesCount)} />
          <Row label="Gross" value={formatMoney(summary.totals.grossMinor)} />
          <Row label="Card" value={formatMoney(summary.totals.cardMinor)} />
          <Row label="Cash" value={formatMoney(summary.totals.cashMinor)} />
          {summary.totals.cashRefundsMinor > 0 && <Row label="Cash refunds" value={`−${formatMoney(summary.totals.cashRefundsMinor)}`} />}
          <Row label="Starting cash" value={formatMoney(summary.openingFloatMinor)} />
        </View>
      )}
      <Text style={styles.muted}>Count the cash in the drawer, including the starting cash.</Text>
      <Field label="Cash counted" value={counted} onChangeText={setCounted} keyboardType="decimal-pad" placeholder="0.00" />
      <ErrorText>{error}</ErrorText>
      <Button title="Close register" onPress={close} busy={busy} disabled={!register} />
    </ScrollView>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={[styles.row, { justifyContent: 'space-between' }]}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={{ fontWeight: '600', color }}>{value}</Text>
    </View>
  );
}

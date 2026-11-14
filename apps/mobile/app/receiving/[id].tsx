import { NetworkError, Receiving, ReceivingTally, variantLabel, type PurchaseOrder } from '@pos/sync';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Switch, Text, TextInput, Vibration, View } from 'react-native';
import { loadCatalog } from '@/catalog-cache';
import { useSession } from '@/session';
import { Button, colors, ErrorText, styles } from '@/ui';

const BARCODES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'qr', 'datamatrix'] as const;
/** The camera reports the same code many times a second. */
const RESCAN_MS = 1500;

type Feedback = { ok: boolean; text: string } | null;

/** Receiving one delivery: scan or tap what arrived, then put it into stock. */
export default function ReceiveOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const receiving = useMemo(() => new Receiving(api, randomUUID), [api]);
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [tally, setTally] = useState<ReceivingTally | null>(null);
  // Kept until the delivery is accepted, so a retry after a dropped connection isn't counted twice.
  const [deliveryId, setDeliveryId] = useState(() => receiving.deliveryId());
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false);
  const [code, setCode] = useState('');
  const [updateCosts, setUpdateCosts] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastScan = useRef({ code: '', at: 0 });
  const catalog = useRef<Awaited<ReturnType<typeof loadCatalog>>['index'] | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await receiving.order(id);
      setOrder(o);
      setTally(ReceivingTally.for(o));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [receiving, id]);

  useEffect(() => {
    void load();
    void loadCatalog().then(({ index }) => (catalog.current = index));
  }, [load]);

  const handleCode = async (raw: string) => {
    const scanned = raw.trim();
    if (!scanned || !tally) return;
    let variant: { id: string; label: string } | null = null;
    const local = catalog.current?.find(scanned);
    if (local) variant = { id: local.id, label: variantLabel(local) };
    else {
      // Not in the downloaded catalog: ask the server.
      variant = await api
        .get<{ id: string; name: string; product: { name: string } }>(`/catalog/lookup?code=${encodeURIComponent(scanned)}`)
        .then((v) => ({ id: v.id, label: v.name === 'Default' ? v.product.name : `${v.product.name} — ${v.name}` }))
        .catch(() => null);
    }
    const line = variant ? tally.lineFor(variant.id) : null;
    if (!line) {
      Vibration.vibrate([0, 80, 60, 80]);
      setFeedback({ ok: false, text: variant ? `${variant.label} isn’t on this order` : `Not found: ${scanned}` });
      return;
    }
    const next = tally.add(line.id);
    setTally(next);
    Vibration.vibrate(40);
    setFeedback({ ok: true, text: `+1 ${line.description} (${next.arrived(line.id)} now)` });
  };

  const onScan = ({ data }: { data: string }) => {
    const now = Date.now();
    if (data === lastScan.current.code && now - lastScan.current.at < RESCAN_MS) return;
    lastScan.current = { code: data, at: now };
    void handleCode(data);
  };

  const submit = async () => {
    if (!order || !tally) return;
    setBusy(true);
    setError('');
    try {
      const after = await receiving.receive(order.id, deliveryId, tally, { updateCosts });
      setDeliveryId(receiving.deliveryId());
      setOrder(after);
      setTally(ReceivingTally.for(after));
      setFeedback({ ok: true, text: `Received ${tally.units} units into stock` });
      if (after.status === 'received') router.back();
    } catch (err) {
      setError(
        err instanceof NetworkError
          ? 'Couldn’t reach the server. Your counts are kept: try again when you’re back online.'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!order || !tally) {
    return (
      <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        {error ? <ErrorText>{error}</ErrorText> : <ActivityIndicator />}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: `${order.reference} · ${order.supplier.name}` }} />
      {camera && permission?.granted && <CameraView style={{ height: 200 }} barcodeScannerSettings={{ barcodeTypes: [...BARCODES] }} onBarcodeScanned={onScan} />}
      <View style={{ padding: 16, gap: 8 }}>
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Scan or type a barcode / SKU"
            placeholderTextColor={colors.muted}
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
            // Hardware scanners type the code and press enter.
            onSubmitEditing={() => {
              void handleCode(code);
              setCode('');
            }}
            blurOnSubmit={false}
          />
          <Button
            title={camera ? 'Hide' : 'Camera'}
            variant="secondary"
            onPress={async () => {
              if (!camera && !(permission?.granted || (await requestPermission()).granted)) return;
              setCamera(!camera);
            }}
          />
        </View>
        {feedback && <Text style={{ color: feedback.ok ? colors.brand : colors.danger }}>{feedback.text}</Text>}
      </View>

      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 6, paddingBottom: 16 }}
        data={tally.lines as PurchaseOrder['lines']}
        keyExtractor={(l) => l.id}
        renderItem={({ item }) => {
          const now = tally.arrived(item.id);
          const left = tally.outstanding(item);
          return (
            <View style={[styles.card, { gap: 6 }]}>
              <Text style={{ fontWeight: '600' }}>{item.description}</Text>
              <Text style={styles.muted}>
                Ordered {item.quantityOrdered} · received {item.quantityReceived}
                {left > 0 ? ` · ${left} still to come` : now > 0 ? ' · all here' : ''}
              </Text>
              <View style={styles.row}>
                <Button title="−" variant="secondary" disabled={now === 0} onPress={() => setTally(tally.set(item.id, now - 1))} style={{ paddingVertical: 6 }} />
                <TextInput
                  style={[styles.input, { width: 72, textAlign: 'center' }]}
                  keyboardType="number-pad"
                  value={String(now)}
                  onChangeText={(t) => setTally(tally.set(item.id, Number(t.replace(/\D/g, '')) || 0))}
                  accessibilityLabel={`Arrived now: ${item.description}`}
                />
                <Button title="+" variant="secondary" onPress={() => setTally(tally.add(item.id))} style={{ paddingVertical: 6 }} />
              </View>
            </View>
          );
        }}
      />

      <View style={{ padding: 16, gap: 8, borderTopWidth: 1, borderColor: colors.border, backgroundColor: '#fff' }}>
        <ErrorText>{error}</ErrorText>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text>Update item costs to this order’s prices</Text>
          <Switch value={updateCosts} onValueChange={setUpdateCosts} />
        </View>
        <View style={styles.row}>
          <Button title="Everything arrived" variant="secondary" onPress={() => setTally(tally.fillAll())} disabled={busy} style={{ flex: 1 }} />
          <Button title={`Receive ${tally.units} units`} onPress={submit} busy={busy} disabled={tally.units === 0} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

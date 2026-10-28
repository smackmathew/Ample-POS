import { variantLabel, type CatalogIndex, type CatalogVariant, type LocalEntry } from '@pos/sync';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, Vibration, View } from 'react-native';
import { loadCatalog } from '@/catalog-cache';
import { useSession } from '@/session';
import { useSync } from '@/sync';
import { Button, colors, styles } from '@/ui';

/** Same code scanned again within this window is treated as one scan. */
const RESCAN_MS = 1500;

type Feedback = { kind: 'ok' | 'error'; text: string } | null;

export default function CountScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { api } = useSession();
  const { engine, flush, version, touch } = useSync();
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false);
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [code, setCode] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const lastScan = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  useEffect(() => {
    void loadCatalog().then(({ index }) => setIndex(index));
  }, []);

  const reload = useCallback(async () => setEntries(await engine.entries(id)), [engine, id]);
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const record = async (variant: CatalogVariant, qty: number) => {
    const label = variantLabel(variant);
    await engine.record({ id: Crypto.randomUUID(), countId: id, variantId: variant.id, label, quantity: qty });
    setFeedback({ kind: 'ok', text: `+${qty} ${label}` });
    Vibration.vibrate(40);
    setQuantity(1);
    touch();
    void flush();
  };

  const handleCode = async (raw: string) => {
    const scanned = raw.trim();
    if (!scanned) return;
    let variant = index?.find(scanned) ?? null;
    if (!variant) {
      // Not in the downloaded catalog: ask the server in case it is new.
      variant = await api
        .get<{ id: string; productId: string; name: string; sku: string | null; priceMinor: number; trackInventory: boolean; barcodes: string[]; product: { name: string } }>(
          `/catalog/lookup?code=${encodeURIComponent(scanned)}`,
        )
        .then((v) => ({ ...v, productName: v.product.name }))
        .catch(() => null);
    }
    if (!variant) {
      setFeedback({ kind: 'error', text: `Not found: ${scanned}. Update products on the counts screen if it is new.` });
      Vibration.vibrate([0, 80, 60, 80]);
      return;
    }
    if (!variant.trackInventory) {
      setFeedback({ kind: 'error', text: `${variantLabel(variant)} is not stock-tracked.` });
      return;
    }
    await record(variant, quantity);
  };

  const onScan = ({ data }: { data: string }) => {
    const now = Date.now();
    if (data === lastScan.current.code && now - lastScan.current.at < RESCAN_MS) return;
    lastScan.current = { code: data, at: now };
    void handleCode(data);
  };

  const undo = (entry: LocalEntry) =>
    Alert.alert('Remove entry?', `${entry.quantity} × ${entry.label}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void engine.void(entry.id).then(() => { touch(); void flush(); }) },
    ]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await flush();
      const status = await engine.status(id);
      if (result.stopped || status.pending > 0) {
        Alert.alert(
          'Not synced yet',
          result.stopped === 'subscription_required'
            ? 'The free trial has ended. Your scans are kept on this device and will sync once the owner subscribes.'
            : 'Some entries have not reached the server. Connect to the network and try again.',
        );
        return;
      }
      await api.post(`/inventory/counts/${id}/submit`);
      Alert.alert('Submitted', 'A manager can now review and approve this count.');
      router.back();
    } catch (err) {
      Alert.alert('Could not submit', (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const live = entries.filter((e) => !e.voided);
  const totals = useMemo(() => {
    const map = new Map<string, { label: string; quantity: number }>();
    for (const e of live) map.set(e.variantId, { label: e.label, quantity: (map.get(e.variantId)?.quantity ?? 0) + e.quantity });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [live]);
  const pending = live.filter((e) => e.state === 'pending').length + entries.filter((e) => e.voidState === 'pending').length;
  const failed = live.filter((e) => e.state === 'failed');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: name ?? 'Count' }} />
      {camera && permission?.granted && (
        <CameraView
          style={{ height: 220 }}
          barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'qr', 'datamatrix'] }}
          onBarcodeScanned={onScan}
        />
      )}
      <View style={{ padding: 16, gap: 10 }}>
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Barcode or SKU"
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            // Hardware scanners on rugged handhelds type the code and press enter.
            onSubmitEditing={() => {
              void handleCode(code);
              setCode('');
            }}
            blurOnSubmit={false}
          />
          <Button
            title={camera ? 'Hide camera' : 'Camera'}
            variant="secondary"
            onPress={async () => {
              if (!camera && !(permission?.granted || (await requestPermission()).granted)) return;
              setCamera(!camera);
            }}
          />
        </View>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.muted}>Quantity per scan</Text>
          <View style={styles.row}>
            <Button title="−" variant="secondary" onPress={() => setQuantity((q) => Math.max(1, q - 1))} />
            <Text style={{ minWidth: 32, textAlign: 'center', fontSize: 18 }}>{quantity}</Text>
            <Button title="+" variant="secondary" onPress={() => setQuantity((q) => q + 1)} />
          </View>
        </View>
        {feedback && <Text style={{ color: feedback.kind === 'ok' ? colors.brand : colors.danger, fontSize: 16 }}>{feedback.text}</Text>}
        <Text style={styles.muted}>
          {totals.length} items · {live.reduce((n, e) => n + e.quantity, 0)} units ·{' '}
          {pending ? `${pending} waiting to sync` : 'all synced'}
        </Text>
        {failed.length > 0 && (
          <Text style={{ color: colors.danger }}>
            {failed.length} entries were refused: {failed[0]!.error}
          </Text>
        )}
      </View>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 6 }}
        data={[...live].reverse()}
        keyExtractor={(e) => e.id}
        ListHeaderComponent={
          totals.length ? (
            <View style={[styles.card, { marginBottom: 8 }]}>
              {totals.map((t) => (
                <View key={t.label} style={[styles.row, { justifyContent: 'space-between' }]}>
                  <Text>{t.label}</Text>
                  <Text style={{ fontWeight: '600' }}>{t.quantity}</Text>
                </View>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onLongPress={() => undo(item)} style={[styles.card, styles.row, { justifyContent: 'space-between', paddingVertical: 10 }]}>
            <Text style={{ flex: 1 }}>
              {item.quantity} × {item.label}
            </Text>
            <Text style={{ color: item.state === 'failed' ? colors.danger : item.state === 'pending' ? colors.warn : colors.muted, fontSize: 12 }}>
              {item.state === 'synced' ? 'synced' : item.state === 'pending' ? 'waiting' : 'refused'}
            </Text>
          </Pressable>
        )}
        ListFooterComponent={live.length ? <Text style={[styles.muted, { textAlign: 'center', marginVertical: 8 }]}>Long-press an entry to remove it.</Text> : null}
      />
      <View style={{ padding: 16 }}>
        <Button title="Submit count" onPress={submit} busy={submitting} disabled={!live.length} />
      </View>
    </View>
  );
}

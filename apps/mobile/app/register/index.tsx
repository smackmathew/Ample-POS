import { formatMoney, parseMoney, type CatalogVariant } from '@pos/sync';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, TextInput, Vibration, View } from 'react-native';
import { useRegister } from '@/register';
import { useSession } from '@/session';
import { useTerminal } from '@/terminal';
import { Button, colors, ErrorText, Field, styles } from '@/ui';

const BARCODES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'qr', 'datamatrix'] as const;

/** The register: open it with a float, ring up items, then charge. */
export default function RegisterScreen() {
  const { register, error } = useRegister();
  if (register === undefined) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  return register ? <Sell /> : <OpenRegister loadError={error} />;
}

function OpenRegister({ loadError }: { loadError: string | null }) {
  const { session, leaveBusiness, signOut } = useSession();
  const { checkout, reloadRegister } = useRegister();
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = async () => {
    const minor = parseMoney(float || '0');
    if (minor === null) return setError('Enter the cash in the drawer, e.g. 150 or 150.00');
    setBusy(true);
    setError('');
    try {
      await checkout.openRegister(session.device!.locationId, minor);
      await reloadRegister();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Stack.Screen options={{ title: session.device?.name ?? 'Register' }} />
      <View style={styles.card}>
        <Text style={{ fontWeight: '600' }}>
          {session.device?.name} · {session.device?.locationName}
        </Text>
        <Text style={styles.muted}>{session.tenantName}</Text>
      </View>
      <Text style={styles.title}>Open the register</Text>
      <Text style={styles.muted}>Count the cash in the drawer before the first sale.</Text>
      <Field label="Starting cash" value={float} onChangeText={setFloat} keyboardType="decimal-pad" placeholder="0.00" />
      <ErrorText>{error || loadError}</ErrorText>
      <Button title="Open register" onPress={open} busy={busy} />
      <View style={{ height: 24 }} />
      <Button title="Leave this business" variant="secondary" onPress={() => confirmLeave(async () => { await leaveBusiness(); router.replace('/'); })} />
      <Button title={`Sign out (${session.email ?? ''})`} variant="danger" onPress={async () => { await signOut(); router.replace('/'); }} />
    </ScrollView>
  );
}

function confirmLeave(onConfirm: () => void) {
  Alert.alert('Leave this business?', 'This register will need to be paired again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: onConfirm },
  ]);
}

function Sell() {
  const { catalog, cart, setCart, checkout, register, saleId, terminal, refreshCatalog } = useRegister();
  const reader = useTerminal();
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false);
  const [query, setQuery] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [charging, setCharging] = useState(false);
  const lastScan = useRef({ code: '', at: 0 });

  const add = (v: CatalogVariant) => {
    setCart(cart.add(v));
    setFeedback({ ok: true, text: `Added ${v.productName}${v.name === 'Default' ? '' : ` — ${v.name}`}` });
  };

  const handleCode = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const v = catalog.find(trimmed);
    if (v) {
      add(v);
      setQuery('');
    } else {
      Vibration.vibrate(200);
      // Not a code: treat it as a name search.
      if (!catalog.search(trimmed).length) setFeedback({ ok: false, text: `No product matches “${trimmed}”` });
    }
  };

  const charge = async () => {
    setCharging(true);
    try {
      // The same sale id is sent again on retry; the server returns the sale it already made.
      await checkout.createSale(saleId, register!.id, cart);
      router.push('/register/pay');
    } catch (err) {
      Alert.alert('Could not start the sale', (err as Error).message);
    } finally {
      setCharging(false);
    }
  };

  const results = query.trim() ? catalog.search(query) : [];
  const readerNote =
    terminal?.readers === 'sdk' && !reader.connected ? (reader.available ? 'No card reader connected' : 'Card readers need the Ample POS app build') : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => menu(refreshCatalog)} hitSlop={12}>
              <Text style={{ color: colors.brand, fontSize: 16 }}>More</Text>
            </Pressable>
          ),
        }}
      />
      {camera && permission?.granted && (
        <CameraView
          style={{ height: 200 }}
          barcodeScannerSettings={{ barcodeTypes: [...BARCODES] }}
          onBarcodeScanned={({ data }) => {
            // The camera reports the same code many times a second.
            if (data === lastScan.current.code && Date.now() - lastScan.current.at < 1500) return;
            lastScan.current = { code: data, at: Date.now() };
            handleCode(data);
          }}
        />
      )}
      <View style={{ padding: 16, gap: 8 }}>
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Scan, or search by name"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            // Hardware scanners type the code and press enter.
            onSubmitEditing={() => handleCode(query)}
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
        {readerNote && (
          <Pressable onPress={() => router.push('/register/reader')}>
            <Text style={{ color: colors.warn }}>{readerNote} — set up</Text>
          </Pressable>
        )}
      </View>

      {results.length > 0 ? (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 6 }}
          data={results}
          keyExtractor={(v) => v.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                add(item);
                setQuery('');
              }}
              style={[styles.card, styles.row, { justifyContent: 'space-between' }]}
            >
              <Text style={{ flex: 1 }}>
                {item.productName}
                {item.name === 'Default' ? '' : ` — ${item.name}`}
              </Text>
              <Text style={{ fontWeight: '600' }}>{formatMoney(item.priceMinor)}</Text>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 6 }}
          data={cart.lines}
          keyExtractor={(l) => l.variantId}
          ListEmptyComponent={<Text style={[styles.muted, { textAlign: 'center', marginTop: 32 }]}>Scan or search to add items.</Text>}
          renderItem={({ item }) => (
            <View style={[styles.card, { gap: 6 }]}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Text style={{ flex: 1 }}>{item.label}</Text>
                <Text style={{ fontWeight: '600' }}>{formatMoney(item.unitMinor * item.quantity)}</Text>
              </View>
              <View style={styles.row}>
                <Button title="−" variant="secondary" onPress={() => setCart(cart.setQuantity(item.variantId, item.quantity - 1))} style={{ paddingVertical: 6 }} />
                <Text style={{ minWidth: 32, textAlign: 'center', fontSize: 16 }}>{item.quantity}</Text>
                <Button title="+" variant="secondary" onPress={() => setCart(cart.setQuantity(item.variantId, item.quantity + 1))} style={{ paddingVertical: 6 }} />
                <Text style={[styles.muted, { marginLeft: 'auto' }]}>{formatMoney(item.unitMinor)} each</Text>
              </View>
            </View>
          )}
        />
      )}

      <View style={{ padding: 16, gap: 8, borderTopWidth: 1, borderColor: colors.border, backgroundColor: '#fff' }}>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.muted}>
            {cart.itemCount} item{cart.itemCount === 1 ? '' : 's'} · before tax
          </Text>
          <Text style={{ fontSize: 20, fontWeight: '600' }}>{formatMoney(cart.subtotalMinor)}</Text>
        </View>
        <Button title="Charge" onPress={charge} busy={charging} disabled={!cart.lines.length} />
      </View>
    </View>
  );
}

function menu(refreshCatalog: () => Promise<void>) {
  Alert.alert('Register', undefined, [
    { text: 'Card reader', onPress: () => router.push('/register/reader') },
    {
      text: 'Update products',
      onPress: () =>
        void refreshCatalog().then(
          () => Alert.alert('Products updated'),
          (err: Error) => Alert.alert('Could not update products', err.message),
        ),
    },
    { text: 'Close register', onPress: () => router.push('/register/close') },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

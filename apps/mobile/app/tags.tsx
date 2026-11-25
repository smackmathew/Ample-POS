import { CatalogIndex, formatMoney, variantLabel, type CatalogVariant } from '@pos/sync';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { loadCatalog } from '@/catalog-cache';
import { loadDeviceSetup, printTags, type DevicePrinter } from '@/printing';
import { useSession } from '@/session';
import { Button, colors, ErrorText, styles } from '@/ui';

interface Line {
  variant: CatalogVariant;
  copies: number;
}

/**
 * Price tags: scan or search products, choose how many of each, and print on
 * one of the location's tag printers. Works on registers and handhelds.
 */
export default function PrintTags() {
  const { api } = useSession();
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [printers, setPrinters] = useState<DevicePrinter[] | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void loadCatalog().then(({ index }) => setIndex(index));
    loadDeviceSetup(api)
      .then((setup) => {
        const tagPrinters = setup.printers.filter((p) => p.kind === 'tag');
        setPrinters(tagPrinters);
        setPrinterId(tagPrinters[0]?.id ?? null);
        setCurrency(setup.currency);
      })
      .catch((err: Error) => {
        setPrinters([]);
        setNote({ ok: false, text: err.message });
      });
  }, [api]);

  const matches = useMemo(() => (index && query.trim().length >= 2 ? index.search(query, 8) : []), [index, query]);
  const printer = printers?.find((p) => p.id === printerId);
  const total = lines.reduce((n, l) => n + l.copies, 0);

  const add = (variant: CatalogVariant) => {
    setLines((prev) => {
      const found = prev.find((l) => l.variant.id === variant.id);
      return found ? prev.map((l) => (l === found ? { ...l, copies: l.copies + 1 } : l)) : [...prev, { variant, copies: 1 }];
    });
    setQuery('');
    setNote(null);
  };

  // Scanners type the code and press enter; a code that isn't a barcode or SKU stays as a search.
  const submit = () => {
    const hit = index?.find(query);
    if (hit) add(hit);
    else if (matches.length === 1) add(matches[0]!);
    else if (query.trim()) setNote({ ok: false, text: `No product with code ${query.trim()}` });
  };

  const print = async () => {
    if (!printer) return;
    setBusy(true);
    setNote(null);
    try {
      const text = await printTags(
        lines.map((l) => ({
          tag: { name: l.variant.productName, variant: l.variant.name, priceMinor: l.variant.priceMinor, currency, sku: l.variant.sku, barcode: l.variant.barcodes[0] ?? null },
          copies: l.copies,
        })),
        printer,
      );
      setNote({ ok: true, text });
      setLines([]);
    } catch (err) {
      setNote({ ok: false, text: `Couldn’t print: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Print tags' }} />
      <View style={{ padding: 16, gap: 10 }}>
        {printers === null ? (
          <Text style={styles.muted}>Loading printers…</Text>
        ) : printers.length === 0 ? (
          <Text style={{ color: colors.warn }}>No tag printer at this location yet. Add one in the web hub under Devices → Printers.</Text>
        ) : (
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            {printers.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setPrinterId(p.id)}
                style={[styles.card, { paddingVertical: 8, borderColor: p.id === printerId ? colors.brand : '#e7e5e4', borderWidth: p.id === printerId ? 2 : 1 }]}
              >
                <Text style={{ fontWeight: '600' }}>{p.name}</Text>
                <Text style={styles.muted}>{p.paper ?? '2x1in'}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <TextInput
          style={styles.input}
          placeholder="Scan a barcode, or search by name or SKU"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={submit}
          blurOnSubmit={false}
        />
        {matches.map((v) => (
          <Pressable key={v.id} onPress={() => add(v)} style={[styles.card, styles.row, { justifyContent: 'space-between', paddingVertical: 10 }]}>
            <Text style={{ flex: 1 }}>{variantLabel(v)}</Text>
            <Text style={styles.muted}>{formatMoney(v.priceMinor, currency)}</Text>
          </Pressable>
        ))}
        {note && <Text style={{ color: note.ok ? colors.brand : colors.danger }}>{note.text}</Text>}
        <ErrorText>{index && index.size === 0 ? 'No products on this device yet. Update products first.' : null}</ErrorText>
      </View>
      <FlatList
        data={lines}
        keyExtractor={(l) => l.variant.id}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        ListEmptyComponent={<Text style={styles.muted}>Scan or search for the products to tag.</Text>}
        renderItem={({ item }) => (
          <View style={[styles.card, styles.row, { justifyContent: 'space-between' }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600' }}>{variantLabel(item.variant)}</Text>
              <Text style={styles.muted}>
                {formatMoney(item.variant.priceMinor, currency)}
                {item.variant.sku ? ` · ${item.variant.sku}` : ''}
              </Text>
            </View>
            <Button
              title="−"
              variant="secondary"
              onPress={() => setLines((prev) => prev.flatMap((l) => (l === item ? (l.copies > 1 ? [{ ...l, copies: l.copies - 1 }] : []) : [l])))}
            />
            <Text style={{ minWidth: 32, textAlign: 'center', fontSize: 18 }}>{item.copies}</Text>
            <Button title="+" variant="secondary" onPress={() => setLines((prev) => prev.map((l) => (l === item ? { ...l, copies: l.copies + 1 } : l)))} />
          </View>
        )}
      />
      <View style={{ padding: 16 }}>
        <Button title={total ? `Print ${total} tag${total === 1 ? '' : 's'}` : 'Print tags'} onPress={() => void print()} busy={busy} disabled={!printer || !total} />
      </View>
    </View>
  );
}

import type { Customer } from '@pos/sync';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useRegister } from '@/register';
import { Button, colors, ErrorText, Field, styles } from '@/ui';

/** Find a customer for the sale by name, email or phone, or add a new one. */
export default function CustomerScreen() {
  const { checkout, customer, setCustomer } = useRegister();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound([]);
    let live = true;
    const timer = setTimeout(() => {
      checkout.findCustomers(q).then(
        (list) => live && setFound(list),
        (err: Error) => live && setError(err.message),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, checkout]);

  const choose = (c: Customer | null) => {
    setCustomer(c);
    router.back();
  };

  const startAdding = () => {
    const q = query.trim();
    setDraft(q.includes('@') ? { name: '', email: q, phone: '' } : /^[+\d\s().-]{7,}$/.test(q) ? { name: '', email: '', phone: q } : { name: q, email: '', phone: '' });
    setAdding(true);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { customer: c } = await checkout.addCustomer(draft);
      choose(c);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (adding) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>New customer</Text>
        <Field label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} autoCapitalize="words" autoFocus />
        <Field label="Email (for receipts)" value={draft.email} onChangeText={(email) => setDraft({ ...draft, email })} keyboardType="email-address" autoComplete="email" />
        <Field label="Phone" value={draft.phone} onChangeText={(phone) => setDraft({ ...draft, phone })} keyboardType="phone-pad" />
        <ErrorText>{error}</ErrorText>
        <Button title="Add to sale" onPress={save} busy={busy} disabled={!draft.name.trim()} />
        <Button title="Back to search" variant="secondary" onPress={() => setAdding(false)} />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { flex: 1 }]}>
      {customer && (
        <View style={[styles.card, styles.row, { justifyContent: 'space-between' }]}>
          <Text style={{ flex: 1 }}>
            On this sale: <Text style={{ fontWeight: '600' }}>{customer.name}</Text>
          </Text>
          <Button title="Remove" variant="secondary" onPress={() => choose(null)} />
        </View>
      )}
      <TextInput
        style={styles.input}
        placeholder="Name, email or phone"
        placeholderTextColor={colors.muted}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoFocus
      />
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={found}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 6 }}
        renderItem={({ item }) => (
          <Pressable onPress={() => choose(item)} style={styles.card}>
            <Text style={{ fontWeight: '600' }}>{item.name}</Text>
            {(item.email || item.phone) && <Text style={styles.muted}>{item.email ?? item.phone}</Text>}
          </Pressable>
        )}
        ListFooterComponent={<Button title={query.trim() && !found.length ? `New customer “${query.trim()}”` : 'New customer'} variant="secondary" onPress={startAdding} />}
      />
    </View>
  );
}

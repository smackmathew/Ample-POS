import { ApiError } from '@pos/sync';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { loadCatalog, refreshCatalog } from '@/catalog-cache';
import { getMeta, setMeta } from '@/db';
import { useSession } from '@/session';
import { useSync } from '@/sync';
import { Button, colors, ErrorText, Field, styles } from '@/ui';

interface CountSummary {
  id: string;
  name: string;
  startedAt: string;
  entryCount: number;
}

const CACHE_KEY = 'openCounts';

export default function Counts() {
  const { api, session, leaveBusiness, signOut } = useSession();
  const { last, flush, engine } = useSync();
  const [revoked, setRevoked] = useState(false);
  const [counts, setCounts] = useState<CountSummary[]>([]);
  const [offline, setOffline] = useState(false);
  const [catalog, setCatalog] = useState<{ size: number; syncedAt: string | null }>({ size: 0, syncedAt: null });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locationId = session.device?.locationId;

  const load = useCallback(async () => {
    setError('');
    const local = await loadCatalog();
    setCatalog({ size: local.index.size, syncedAt: local.syncedAt });
    try {
      const list = await api.get<CountSummary[]>(`/inventory/counts?status=open&locationId=${locationId}`);
      setCounts(list);
      setOffline(false);
      setRevoked(false);
      await setMeta(CACHE_KEY, JSON.stringify(list));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('This device was revoked or your sign-in expired. Pair again to continue.');
        setRevoked(true);
        return;
      }
      // Offline: show the counts we knew about so counting can continue.
      setOffline(true);
      const cached = await getMeta(CACHE_KEY);
      if (cached) setCounts(JSON.parse(cached) as CountSummary[]);
    }
  }, [api, locationId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const start = async () => {
    setBusy(true);
    try {
      const count = await api.post<{ id: string; name: string }>('/inventory/counts', { locationId, name: name.trim() });
      setName('');
      router.push({ pathname: '/counts/[id]', params: { id: count.id, name: count.name } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateCatalog = async () => {
    setBusy(true);
    try {
      const index = await refreshCatalog(api);
      setCatalog({ size: index.size, syncedAt: new Date().toISOString() });
    } catch (err) {
      setError(`Could not download products: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Unpairing and signing out wipe local data, so never do it silently with scans still queued. */
  const confirmLeave = async (label: string, action: () => Promise<void>) => {
    const { pending } = await engine.status();
    const run = () => void action().then(() => router.replace('/'));
    if (!pending) return run();
    Alert.alert(`${pending} scans have not synced`, 'They will be lost. Connect to the network and let them sync first.', [
      { text: 'Cancel', style: 'cancel' },
      { text: `${label} anyway`, style: 'destructive', onPress: run },
    ]);
  };

  const menu = () =>
    Alert.alert(session.device?.name ?? 'Device', `${session.tenantName} · ${session.email}`, [
      { text: 'Unpair device', style: 'destructive', onPress: () => void confirmLeave('Unpair', leaveBusiness) },
      { text: 'Sign out', style: 'destructive', onPress: () => void confirmLeave('Sign out', signOut) },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <FlatList
      contentContainerStyle={styles.screen}
      data={counts}
      keyExtractor={(c) => c.id}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void flush().then(load)} />}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <Pressable onPress={menu} style={styles.card}>
            <Text style={{ fontWeight: '600' }}>
              {session.device?.name} · {session.device?.locationName}
            </Text>
            <Text style={styles.muted}>{session.tenantName}</Text>
            {offline && <Text style={{ color: colors.warn, marginTop: 4 }}>Offline — scans will sync when you reconnect.</Text>}
            {last?.stopped === 'unauthorized' && <Text style={{ color: colors.danger, marginTop: 4 }}>Sync stopped: this device needs to be paired again.</Text>}
          </Pressable>
          <View style={[styles.card, styles.row, { justifyContent: 'space-between' }]}>
            <View style={{ flex: 1 }}>
              <Text>{catalog.size} products on this device</Text>
              <Text style={styles.muted}>{catalog.syncedAt ? `Updated ${new Date(catalog.syncedAt).toLocaleString()}` : 'Not downloaded yet'}</Text>
            </View>
            <Button title="Update" variant="secondary" onPress={updateCatalog} busy={busy} />
          </View>
          <ErrorText>{error}</ErrorText>
          {(revoked || last?.stopped === 'unauthorized') && <Button title="Pair again" onPress={() => router.push('/pair')} />}
          <Field label="New count" placeholder="e.g. Back room shelf A" value={name} onChangeText={setName} />
          <Button title="Start count" onPress={start} disabled={!name.trim() || offline} busy={busy} />
          <Text style={[styles.label, { marginTop: 8 }]}>OPEN COUNTS AT {session.device?.locationName?.toUpperCase()}</Text>
        </View>
      }
      ListEmptyComponent={<Text style={styles.muted}>No open counts. Start one above.</Text>}
      renderItem={({ item }) => (
        <Pressable style={[styles.card, { marginTop: 8 }]} onPress={() => router.push({ pathname: '/counts/[id]', params: { id: item.id, name: item.name } })}>
          <Text style={{ fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
          <Text style={styles.muted}>
            Started {new Date(item.startedAt).toLocaleString()} · {item.entryCount} entries
          </Text>
        </Pressable>
      )}
    />
  );
}

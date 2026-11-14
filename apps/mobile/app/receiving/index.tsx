import { Receiving, type PurchaseOrderSummary } from '@pos/sync';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSession } from '@/session';
import { ErrorText, styles } from '@/ui';

/** Placed purchase orders waiting for stock at this device's location. */
export default function ReceivingList() {
  const { api, session } = useSession();
  const receiving = useMemo(() => new Receiving(api, randomUUID), [api]);
  const [orders, setOrders] = useState<PurchaseOrderSummary[] | null>(null);
  const [error, setError] = useState('');
  const locationId = session.device?.locationId;

  const load = useCallback(async () => {
    if (!locationId) return;
    try {
      setOrders(await receiving.openOrders(locationId));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [receiving, locationId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <FlatList
      contentContainerStyle={styles.screen}
      data={orders ?? []}
      keyExtractor={(o) => o.id}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={styles.muted}>Orders placed with suppliers for {session.device?.locationName}. Pick the one the delivery is for.</Text>
          <ErrorText>{error}</ErrorText>
        </View>
      }
      ListEmptyComponent={orders ? <Text style={styles.muted}>Nothing is on its way. Orders appear here once they’re placed in the hub.</Text> : null}
      renderItem={({ item }) => (
        <Pressable style={[styles.card, { marginTop: 8 }]} onPress={() => router.push({ pathname: '/receiving/[id]', params: { id: item.id } })}>
          <Text style={{ fontSize: 16, fontWeight: '600' }}>
            {item.reference} · {item.supplierName}
          </Text>
          <Text style={styles.muted}>
            {item.itemCount} item{item.itemCount === 1 ? '' : 's'}
            {item.status === 'partially_received' ? ' · partly received' : ''}
            {item.expectedOn ? ` · needed by ${item.expectedOn}` : ''}
          </Text>
        </Pressable>
      )}
    />
  );
}

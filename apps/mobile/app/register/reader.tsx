import { ScrollView, Text, View } from 'react-native';
import { useRegister } from '@/register';
import { useTerminal, type DiscoveryMethod } from '@/terminal';
import { Button, colors, styles } from '@/ui';

/** Find and connect a card reader: Tap to Pay on this device, or a Bluetooth reader. */
export default function ReaderScreen() {
  const { terminal: config } = useRegister();
  const t = useTerminal();

  if (config?.readers === 'simulated') {
    return (
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.title}>Test mode</Text>
        <Text style={styles.muted}>
          Payments use the test processor, so there is no reader to connect. The payment screen shows Approve and Decline buttons instead.
        </Text>
      </ScrollView>
    );
  }
  if (!t.available) {
    return (
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.title}>Card readers unavailable</Text>
        <Text style={styles.muted}>
          Card readers work in the Ample POS app installed from a development or store build. Expo Go doesn’t include the card reader software.
        </Text>
      </ScrollView>
    );
  }
  if (config && !config.location.ready) {
    return (
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.title}>Store address needed</Text>
        <Text style={styles.muted}>{config.location.problem}</Text>
      </ScrollView>
    );
  }

  const find = (method: DiscoveryMethod, simulated = false) => () => void t.discover(method, simulated);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {t.connected ? (
        <View style={[styles.card, { gap: 6 }]}>
          <Text style={{ fontWeight: '600', fontSize: 16 }}>Connected</Text>
          <Text>
            {t.connected.label ?? t.connected.deviceType} {t.connected.simulated ? '(simulated)' : ''}
          </Text>
          <Text style={styles.muted}>
            Serial {t.connected.serialNumber}
            {typeof t.connected.batteryLevel === 'number' ? ` · battery ${Math.round(t.connected.batteryLevel * 100)}%` : ''}
          </Text>
          <Button title="Disconnect" variant="secondary" onPress={() => void t.disconnect()} />
        </View>
      ) : (
        <>
          <Text style={styles.muted}>Choose how this register takes cards.</Text>
          <Button title="Tap to Pay on this device" onPress={find('tapToPay')} disabled={t.discovering} />
          <Button title="Find Bluetooth readers" variant="secondary" onPress={find('bluetoothScan')} disabled={t.discovering} />
          <Button title="Use a simulated reader (Stripe test mode)" variant="secondary" onPress={find('bluetoothScan', true)} disabled={t.discovering} />
          {t.discovering && (
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={styles.muted}>Looking for readers… keep the reader on and nearby.</Text>
              <Button title="Stop" variant="secondary" onPress={() => void t.cancelDiscovery()} />
            </View>
          )}
          {t.discovered.map((r) => (
            <View key={r.serialNumber} style={[styles.card, styles.row, { justifyContent: 'space-between' }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '600' }}>{r.label ?? r.deviceType}</Text>
                <Text style={styles.muted}>{r.serialNumber}</Text>
              </View>
              <Button title="Connect" onPress={() => void t.connect(r)} />
            </View>
          ))}
        </>
      )}
      {t.message && <Text style={{ color: colors.warn }}>{t.message}</Text>}
    </ScrollView>
  );
}

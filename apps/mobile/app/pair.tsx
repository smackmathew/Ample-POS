import { ApiClient, ApiError, parsePairingCode } from '@pos/sync';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { refreshCatalog } from '@/catalog-cache';
import { clearLocalData } from '@/db';
import { useSession } from '@/session';
import { Button, ErrorText, Field, styles } from '@/ui';

interface DeviceInfo {
  id: string;
  name: string;
  location: { id: string; name: string };
}

/** Pairs the phone with a device registered in the admin hub (Devices → Register device). */
export default function Pair() {
  const { session, update, signOut } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const handled = useRef(false);

  const pair = async (text: string) => {
    const code = parsePairingCode(text);
    if (!code) {
      setError('That is not an Ample POS pairing code. Register the device in the admin hub to get one.');
      handled.current = false;
      return;
    }
    setScanning(false);
    setBusy(true);
    setError('');
    try {
      const api = new ApiClient({ baseUrl: code.api, token: session.token, tenantId: code.tenantId, deviceCredential: code.credential });
      const device = await api.get<DeviceInfo>('/device');
      const { tenant } = await api.get<{ tenant: { name: string } }>('/tenant');
      // Entries and catalog from another business must never sync or show here.
      // Same business (e.g. re-pairing after a revoke): keep unsynced scans so they still upload.
      if (session.tenantId && session.tenantId !== code.tenantId) await clearLocalData();
      await update({
        apiUrl: code.api,
        tenantId: code.tenantId,
        tenantName: tenant.name,
        deviceCredential: code.credential,
        device: { id: device.id, name: device.name, locationId: device.location.id, locationName: device.location.name },
      });
      await refreshCatalog(api).catch(() => {});
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError('Your account is not a member of this business. Ask an owner to invite you.');
      else if (err instanceof ApiError && err.status === 401) setError('This pairing code is no longer valid. The device may have been revoked.');
      else setError((err as Error).message);
      handled.current = false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.muted}>
        In the admin hub, open Devices and register this phone as a handheld. Then scan the code it shows.
      </Text>
      {scanning && permission?.granted ? (
        <View style={{ height: 320, borderRadius: 12, overflow: 'hidden' }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              handled.current = true;
              void pair(data);
            }}
          />
        </View>
      ) : (
        <Button
          title="Scan pairing code"
          busy={busy}
          onPress={async () => {
            const granted = permission?.granted || (await requestPermission()).granted;
            if (!granted) return setError('Camera access is needed to scan. You can paste the code below instead.');
            handled.current = false;
            setScanning(true);
          }}
        />
      )}
      <ErrorText>{error}</ErrorText>
      <Field label="Or paste the pairing code" value={manual} onChangeText={setManual} multiline style={{ minHeight: 80 }} />
      <Button title="Pair" variant="secondary" onPress={() => pair(manual)} disabled={!manual.trim() || busy} />
      <Button title={`Sign out (${session.email ?? ''})`} variant="danger" onPress={async () => { await signOut(); router.replace('/'); }} />
    </ScrollView>
  );
}

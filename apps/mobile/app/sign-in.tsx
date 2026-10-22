import { ApiClient } from '@pos/sync';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text } from 'react-native';
import { useSession } from '@/session';
import { Button, ErrorText, Field, styles } from '@/ui';

/**
 * Development sign-in against AUTH_MODE=dev. A production build replaces this
 * with the identity provider's mobile SDK (Clerk, Auth0, ...).
 */
export default function SignIn() {
  const { session, update } = useSession();
  const [apiUrl, setApiUrl] = useState(session.apiUrl);
  const [email, setEmail] = useState(session.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { token } = await new ApiClient({ baseUrl: apiUrl }).post<{ token: string }>('/dev/token', { email: email.trim() });
      await update({ apiUrl, token, email: email.trim() });
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.title}>Ample POS</Text>
      <Text style={styles.muted}>Sign in to count stock on this device.</Text>
      <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="emailAddress" />
      <Field label="Server" value={apiUrl} onChangeText={setApiUrl} keyboardType="url" />
      <ErrorText>{error}</ErrorText>
      <Button title="Sign in" onPress={submit} busy={busy} disabled={!email.includes('@')} />
    </KeyboardAvoidingView>
  );
}

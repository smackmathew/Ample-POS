import { ApiClient, ApiError } from '@pos/sync';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text } from 'react-native';
import { useSession } from '@/session';
import { Button, ErrorText, Field, styles } from '@/ui';

/**
 * Sign in with an Ample POS account (email and password). Accounts are created
 * in the web hub. Against a server in demo mode (AUTH_MODE=dev) only the email
 * is needed.
 */
export default function SignIn() {
  const { session, update } = useSession();
  const [apiUrl, setApiUrl] = useState(session.apiUrl);
  const [email, setEmail] = useState(session.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set after the password step when the account has two-step sign-in.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const finish = async (token: string) => {
    setPassword('');
    setCode('');
    setChallenge(null);
    await update({ apiUrl, token, email: email.trim() });
    router.replace('/');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const client = new ApiClient({ baseUrl: apiUrl });
      if (challenge) {
        const { token } = await client.post<{ token: string }>('/auth/login/2fa', { challenge, code });
        return await finish(token);
      }
      const { mode } = await client.get<{ mode: 'password' | 'dev' | 'jwks' }>('/auth/config');
      const res =
        mode === 'dev'
          ? await client.post<{ token: string }>('/dev/token', { email: email.trim() })
          : await client.post<{ token?: string; twoFactor?: true; challenge?: string }>('/auth/login', { email: email.trim(), password });
      if ('challenge' in res && res.challenge) setChallenge(res.challenge);
      else await finish(res.token!);
    } catch (err) {
      if (err instanceof ApiError && challenge && (err.body as { code?: string } | undefined)?.code === 'challenge_expired') setChallenge(null);
      setError(err instanceof ApiError && err.status === 404 ? 'That server doesn’t look like Ample POS. Check the address.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Ample POS</Text>
        <Text style={styles.muted}>Sign in with your Ample POS account. New here? Create one in the web hub first.</Text>
        {challenge ? (
          <>
            <Text style={styles.muted}>Enter the 6-digit code from your authenticator app, or a recovery code.</Text>
            <Field label="Code" value={code} onChangeText={setCode} textContentType="oneTimeCode" autoComplete="one-time-code" autoFocus onSubmitEditing={submit} />
            <ErrorText>{error}</ErrorText>
            <Button title="Sign in" onPress={submit} busy={busy} disabled={code.trim().length < 6} />
            <Button title="Start over" variant="secondary" onPress={() => { setChallenge(null); setCode(''); setError(''); }} />
          </>
        ) : (
          <>
            <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password" onSubmitEditing={submit} />
            <Field label="Server" value={apiUrl} onChangeText={setApiUrl} keyboardType="url" />
            <ErrorText>{error}</ErrorText>
            <Button title="Sign in" onPress={submit} busy={busy} disabled={!email.includes('@')} />
          </>
        )}
        <Text style={styles.muted}>Forgot your password? Reset it from the web hub’s sign-in page, or ask your business owner for a reset link.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

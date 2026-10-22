import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '@/session';
import { SyncProvider } from '@/sync';

const defaultApiUrl = (Constants.expoConfig?.extra?.defaultApiUrl as string | undefined) ?? 'http://localhost:4000';

export default function RootLayout() {
  return (
    <SessionProvider defaultApiUrl={defaultApiUrl}>
      <SyncProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerTintColor: '#0f766e' }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="pair" options={{ title: 'Pair this device' }} />
          <Stack.Screen name="counts/index" options={{ title: 'Counts' }} />
          <Stack.Screen name="counts/[id]" options={{ title: 'Count' }} />
        </Stack>
      </SyncProvider>
    </SessionProvider>
  );
}

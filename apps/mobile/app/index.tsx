import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '@/session';

/** Sends the user to the first step they haven't completed: sign in, pair, then sell or count. */
export default function Index() {
  const { ready, session } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!session.token) return <Redirect href="/sign-in" />;
  if (!session.deviceCredential || !session.tenantId) return <Redirect href="/pair" />;
  return <Redirect href={session.device?.kind === 'register' ? '/register' : '/counts'} />;
}

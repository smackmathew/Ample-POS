import { Stack } from 'expo-router';
import { RegisterProvider } from '@/register';

export default function RegisterLayout() {
  return (
    <RegisterProvider>
      <Stack screenOptions={{ headerTintColor: '#0f766e' }}>
        <Stack.Screen name="index" options={{ title: 'Register' }} />
        <Stack.Screen name="pay" options={{ title: 'Payment', headerBackTitle: 'Cart' }} />
        <Stack.Screen name="reader" options={{ title: 'Card reader' }} />
        <Stack.Screen name="close" options={{ title: 'Close register' }} />
      </Stack>
    </RegisterProvider>
  );
}

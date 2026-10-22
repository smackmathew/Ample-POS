import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';

export const colors = {
  brand: '#0f766e',
  text: '#1c1917',
  muted: '#78716c',
  border: '#d6d3d1',
  bg: '#fafaf9',
  danger: '#b91c1c',
  warn: '#b45309',
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.secondary,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? '#fff' : colors.text} />
      ) : (
        <Text style={[styles.buttonText, { color: primary ? '#fff' : variant === 'danger' ? colors.danger : colors.text }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={[styles.input, style]} {...rest} />
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <Text style={{ color: colors.danger }}>{children}</Text> : null;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  muted: { color: colors.muted },
  label: { fontSize: 13, color: colors.muted },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, backgroundColor: '#fff', color: colors.text },
  button: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e7e5e4', padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton } from '@/components/icon-button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Asks for camera + microphone. Once the system won't ask again, the only way is the phone's
 * Settings, so it offers to open them. [onClose] adds a close button (screens without a header).
 */
export function PermissionGate({
  why,
  canAsk,
  onRequest,
  onClose,
}: {
  why: string;
  canAsk: boolean;
  onRequest: () => void;
  onClose?: () => void;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.gate, { backgroundColor: theme.background }]}>
      {onClose && (
        <View style={styles.close}>
          <IconButton icon="ion:close" accessibilityLabel="Close" onPress={onClose} />
        </View>
      )}
      <View style={styles.body}>
        <ThemedText type="subtitle">Camera & microphone</ThemedText>
        <ThemedText themeColor="textSecondary">{why}</ThemedText>
        {!canAsk && (
          <ThemedText themeColor="textSecondary">
            Access is turned off. Allow Camera and Microphone for SimpleSwing in your phone&apos;s Settings, then come
            back here.
          </ThemedText>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={canAsk ? onRequest : () => Linking.openSettings().catch(() => {})}
          style={({ pressed }) => [styles.button, { backgroundColor: theme.accent, opacity: pressed ? 0.7 : 1 }]}>
          <ThemedText style={styles.buttonText}>{canAsk ? 'Allow access' : 'Open Settings'}</ThemedText>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  gate: { flex: 1 },
  close: { alignItems: 'flex-start', paddingHorizontal: Spacing.two, paddingTop: Spacing.two },
  body: { flex: 1, padding: Spacing.four, gap: Spacing.three, justifyContent: 'center' },
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  buttonText: { color: '#fff', fontWeight: '700' },
});

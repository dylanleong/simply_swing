import { router, Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

/** Back to where we came from, or to the Swings tab when a link opened this screen with nothing behind it. */
export const leaveToLibrary = () => (router.canGoBack() ? router.back() : router.replace('/library'));

/** A deleted swing, or a link to one that isn't on this phone. */
export function SwingNotFound({ message = 'This swing isn’t on this phone any more.' }: { message?: string }) {
  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Swing not found', headerRight: () => null }} />
      <ThemedText type="smallBold" style={styles.title}>
        Swing not found
      </ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.text}>
        {message}
      </ThemedText>
      <Chip label="Back to Swings" onPress={leaveToLibrary} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three, padding: Spacing.four },
  title: { fontSize: 20, lineHeight: 26 },
  text: { textAlign: 'center' },
});

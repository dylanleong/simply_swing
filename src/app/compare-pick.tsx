import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwingBrowser } from '@/components/swing-browser';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { NO_FILTER, type SwingFilter } from '@/lib/swing-library';
import { listSwings } from '@/lib/swing-store';

/** "Compare with…": pick the second swing. Favourites first if there are any. */
export default function ComparePickScreen() {
  const { a } = useLocalSearchParams<{ a: string }>();
  const swings = useMemo(() => listSwings().filter((s) => s.id !== a), [a]);
  const [filter, setFilter] = useState<SwingFilter>(() =>
    swings.some((s) => s.notes.favorite) ? { ...NO_FILTER, favorites: true } : NO_FILTER
  );

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Compare with…' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          The two swings play side by side, lined up on impact.
        </ThemedText>
        <SwingBrowser
          swings={swings}
          filter={filter}
          onFilterChange={setFilter}
          onPress={(s) => router.replace({ pathname: '/compare', params: { a, b: s.id } })}
          empty="No other swings to compare with yet."
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hint: { paddingHorizontal: Spacing.four, paddingVertical: Spacing.two },
});

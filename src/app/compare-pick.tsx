import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwingBrowser } from '@/components/swing-browser';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useLayout } from '@/hooks/use-layout';
import { NO_FILTER, type Swing, type SwingFilter } from '@/lib/swing-library';
import { listSwingsAsync } from '@/lib/swing-store';

/** "Compare with…": pick the second swing. Favourites first if there are any. */
export default function ComparePickScreen() {
  const { a } = useLocalSearchParams<{ a: string }>();
  /** null until the library has been read, so the empty message doesn't flash first. */
  const [swings, setSwings] = useState<Swing[] | null>(null);
  const [filter, setFilter] = useState<SwingFilter>(NO_FILTER);
  const { columns } = useLayout();

  useEffect(() => {
    let cancelled = false;
    listSwingsAsync().then((all) => {
      if (cancelled) return;
      const others = all.filter((s) => s.id !== a);
      setSwings(others);
      if (others.some((s) => s.notes.favorite)) setFilter({ ...NO_FILTER, favorites: true });
    });
    return () => {
      cancelled = true;
    };
  }, [a]);

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Compare with…' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
          The two swings play side by side, lined up on impact.
        </ThemedText>
        {swings && (
          <SwingBrowser
            swings={swings}
            filter={filter}
            onFilterChange={setFilter}
            onPress={(s) => router.replace({ pathname: '/compare', params: { a, b: s.id } })}
            columns={columns}
            empty="No other swings to compare with yet."
          />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hint: { paddingHorizontal: Spacing.four, paddingVertical: Spacing.two },
});

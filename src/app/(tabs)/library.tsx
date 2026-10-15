import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwingBrowser } from '@/components/swing-browser';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { filterSwings, NO_FILTER, type Swing, type SwingFilter } from '@/lib/swing-library';
import { deleteSwings, listSwings } from '@/lib/swing-store';

export default function LibraryScreen() {
  const theme = useTheme();
  const [swings, setSwings] = useState<Swing[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<SwingFilter>(NO_FILTER);
  /** null = browsing; a Set = selection mode (possibly empty). */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const selecting = selected !== null;
  const shown = useMemo(() => filterSwings(swings, filter), [swings, filter]);

  const reload = useCallback(() => {
    setSwings(listSwings());
  }, []);

  // Clips are added from the Capture tab (and deleted or tagged in review), so re-read on every visit.
  useFocusEffect(
    useCallback(() => {
      reload();
      // Leaving the tab ends selection mode.
      return () => setSelected(null);
    }, [reload])
  );

  const onRefresh = () => {
    setRefreshing(true);
    reload();
    setRefreshing(false);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // "All" means all that the filter shows.
  const allSelected = selecting && shown.length > 0 && shown.every((s) => selected.has(s.id));

  const confirmDelete = () => {
    if (!selected || selected.size === 0) return;
    const count = selected.size;
    Alert.alert(
      `Delete ${count} swing${count === 1 ? '' : 's'}?`,
      'This removes the clips from your phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteSwings([...selected]);
            setSelected(null);
            reload();
          },
        },
      ]
    );
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.container} edges={['top']}>
        {selecting ? (
          <View style={styles.header}>
            <HeaderButton label="Cancel" onPress={() => setSelected(null)} />
            <ThemedText type="smallBold" style={styles.selectTitle}>
              {selected.size === 0 ? 'Select swings' : `${selected.size} selected`}
            </ThemedText>
            <HeaderButton
              label={allSelected ? 'None' : 'All'}
              onPress={() => setSelected(allSelected ? new Set() : new Set(shown.map((s) => s.id)))}
            />
          </View>
        ) : (
          <View style={styles.header}>
            <ThemedText type="subtitle">Swings</ThemedText>
            {swings.length > 0 && <HeaderButton label="Select" onPress={() => setSelected(new Set())} />}
          </View>
        )}
        <SwingBrowser
          swings={swings}
          filter={filter}
          onFilterChange={setFilter}
          selected={selected}
          onPress={(s) => (selecting ? toggle(s.id) : router.push({ pathname: '/swing/[id]', params: { id: s.id } }))}
          onLongPress={(s) => toggle(s.id)}
          refreshing={refreshing}
          onRefresh={onRefresh}
          bottomInset={selecting ? 72 : 0}
          empty="No swings yet. On the Capture tab the camera is always recording — hit a ball, or tap Save after your swing to keep the last few seconds."
        />
        {selecting && (
          <View style={[styles.deleteBar, { backgroundColor: theme.background }]}>
            <Pressable
              accessibilityRole="button"
              disabled={selected.size === 0}
              onPress={confirmDelete}
              style={({ pressed }) => [
                styles.deleteButton,
                { backgroundColor: theme.danger, opacity: selected.size === 0 ? 0.4 : pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={styles.deleteLabel}>
                {selected.size === 0
                  ? 'Tap swings to select'
                  : `Delete ${selected.size} swing${selected.size === 1 ? '' : 's'}`}
              </ThemedText>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <ThemedText style={{ color: theme.accent, fontWeight: '600' }}>{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  selectTitle: { fontSize: 17 },
  deleteBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(127,127,127,0.4)',
  },
  deleteButton: { alignItems: 'center', paddingVertical: Spacing.three, borderRadius: Spacing.three },
  deleteLabel: { color: '#fff', fontWeight: '700' },
});

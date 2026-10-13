import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClipTime, SOURCE_LABEL, type Swing } from '@/lib/swing-library';
import { deleteSwings, listSwings } from '@/lib/swing-store';

export default function LibraryScreen() {
  const theme = useTheme();
  const [swings, setSwings] = useState<Swing[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  /** null = browsing; a Set = selection mode (possibly empty). */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const selecting = selected !== null;

  const reload = useCallback(() => {
    setSwings(listSwings());
  }, []);

  // Clips are added from the Capture tab (and deleted in review), so re-read on every visit.
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

  const allSelected = selecting && swings.length > 0 && selected.size === swings.length;

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
              onPress={() => setSelected(allSelected ? new Set() : new Set(swings.map((s) => s.id)))}
            />
          </View>
        ) : (
          <View style={styles.header}>
            <ThemedText type="subtitle">Swings</ThemedText>
            {swings.length > 0 && <HeaderButton label="Select" onPress={() => setSelected(new Set())} />}
          </View>
        )}
        <FlatList
          data={swings}
          keyExtractor={(s) => s.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[styles.list, selecting && styles.listWithBar]}
          refreshing={refreshing}
          onRefresh={onRefresh}
          extraData={selected}
          renderItem={({ item }) => (
            <SwingTile
              swing={item}
              selecting={selecting}
              selected={selected?.has(item.id) ?? false}
              onPress={() =>
                selecting ? toggle(item.id) : router.push({ pathname: '/swing/[id]', params: { id: item.id } })
              }
              onLongPress={() => toggle(item.id)}
            />
          )}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary">
              No swings yet. On the Capture tab the camera is always recording — hit a ball, or tap
              Save after your swing to keep the last few seconds.
            </ThemedText>
          }
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

function SwingTile({
  swing,
  selecting,
  selected,
  onPress,
  onLongPress,
}: {
  swing: Swing;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const theme = useTheme();
  const details = [
    swing.source && SOURCE_LABEL[swing.source],
    swing.durationMs && `${(swing.durationMs / 1000).toFixed(1)} s`,
    swing.fps && `${swing.fps} fps`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`Swing at ${formatClipTime(swing.createdAt)}`}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.7 : 1 }]}>
      <View
        style={[
          styles.thumb,
          { backgroundColor: theme.backgroundElement },
          selected && { borderColor: theme.accent, borderWidth: 3 },
        ]}>
        {swing.thumbUri && <Image source={swing.thumbUri} style={StyleSheet.absoluteFill} contentFit="cover" />}
        {swing.angle && (
          <View style={styles.angles}>
            <ThemedText style={styles.anglesText}>2 angles</ThemedText>
          </View>
        )}
        {selecting && (
          <View
            style={[
              styles.check,
              selected ? { backgroundColor: theme.accent, borderColor: theme.accent } : styles.checkEmpty,
            ]}>
            {selected && <ThemedText style={styles.checkMark}>✓</ThemedText>}
          </View>
        )}
      </View>
      <ThemedText type="smallBold">{formatClipTime(swing.createdAt)}</ThemedText>
      {details ? (
        <ThemedText type="small" themeColor="textSecondary">
          {details}
        </ThemedText>
      ) : null}
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
  list: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.four, gap: Spacing.three },
  // Room for the delete bar so the last row can scroll clear of it.
  listWithBar: { paddingBottom: 96 },
  row: { gap: Spacing.three },
  // maxWidth keeps a lone tile in the last row from stretching across both columns.
  tile: { flex: 1, maxWidth: '48.5%', gap: Spacing.one },
  thumb: { width: '100%', aspectRatio: 9 / 16, borderRadius: Spacing.two, overflow: 'hidden' },
  check: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  angles: {
    position: 'absolute',
    left: Spacing.two,
    bottom: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  anglesText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  checkEmpty: { borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)' },
  checkMark: { color: '#fff', fontWeight: '700', lineHeight: 20 },
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

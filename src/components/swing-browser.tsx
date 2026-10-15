import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, SectionList, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  filterSwings,
  formatClipTime,
  formatSession,
  groupSessions,
  NO_FILTER,
  formatTempoRatio,
  SOURCE_LABEL,
  type Swing,
  type SwingFilter,
} from '@/lib/swing-library';
import { CLUBS, notesSummary, RESULT_LABEL, SHOT_RESULTS } from '@/lib/swing-notes';

type Row = { key: string; swings: Swing[] };

/**
 * The swing grid: a filter bar (favourites, club, result) over swings grouped into practice
 * sessions. Used by the Swings tab and by "compare with…".
 */
export function SwingBrowser({
  swings,
  filter,
  onFilterChange,
  selected,
  onPress,
  onLongPress,
  refreshing,
  onRefresh,
  empty,
  bottomInset = 0,
}: {
  swings: Swing[];
  filter: SwingFilter;
  onFilterChange: (filter: SwingFilter) => void;
  /** Selection mode when set (possibly empty). */
  selected?: Set<string> | null;
  onPress: (swing: Swing) => void;
  onLongPress?: (swing: Swing) => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  empty: string;
  bottomInset?: number;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const shown = useMemo(() => filterSwings(swings, filter), [swings, filter]);
  const sections = useMemo(
    () =>
      groupSessions(shown).map((session) => {
        const rows: Row[] = [];
        for (let i = 0; i < session.swings.length; i += 2) {
          const pair = session.swings.slice(i, i + 2);
          rows.push({ key: pair.map((s) => s.id).join('|'), swings: pair });
        }
        return { key: `${session.start}`, title: formatSession(session), count: session.swings.length, data: rows };
      }),
    [shown]
  );
  const filtering = filter.club != null || filter.result != null || filter.favorites;
  const filterLabel = [filter.favorites && '★', filter.club, filter.result && RESULT_LABEL[filter.result]]
    .filter(Boolean)
    .join(' · ');

  return (
    <SectionList
      sections={sections}
      keyExtractor={(row) => row.key}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={[styles.list, { paddingBottom: Spacing.four + bottomInset }]}
      refreshing={refreshing}
      onRefresh={onRefresh}
      extraData={selected}
      ListHeaderComponent={
        swings.length > 0 ? (
          <View style={styles.filters}>
            <View style={styles.filterRow}>
              <Chip
                compact
                label={filtering ? `Filter: ${filterLabel}` : 'Filter'}
                selected={filtering}
                onPress={() => setFilterOpen((o) => !o)}
              />
              {filtering && <Chip compact label="Clear" onPress={() => onFilterChange(NO_FILTER)} />}
            </View>
            {filterOpen && (
              <View style={styles.filterPanel}>
                <Chip
                  compact
                  label="★ Favourites"
                  selected={filter.favorites}
                  onPress={() => onFilterChange({ ...filter, favorites: !filter.favorites })}
                />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  <Chip compact label="Any club" selected={filter.club == null} onPress={() => onFilterChange({ ...filter, club: null })} />
                  {CLUBS.map((c) => (
                    <Chip key={c} compact label={c} selected={filter.club === c} onPress={() => onFilterChange({ ...filter, club: c })} />
                  ))}
                </ScrollView>
                <View style={styles.wrapRow}>
                  <Chip compact label="Any result" selected={filter.result == null} onPress={() => onFilterChange({ ...filter, result: null })} />
                  {SHOT_RESULTS.map((r) => (
                    <Chip
                      key={r}
                      compact
                      label={RESULT_LABEL[r]}
                      selected={filter.result === r}
                      onPress={() => onFilterChange({ ...filter, result: r })}
                    />
                  ))}
                </View>
              </View>
            )}
          </View>
        ) : null
      }
      renderSectionHeader={({ section }) => (
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionHeader}>
          {`${section.title} · ${section.count} swing${section.count === 1 ? '' : 's'}`}
        </ThemedText>
      )}
      renderItem={({ item }) => (
        <View style={styles.row}>
          {item.swings.map((s) => (
            <SwingTile
              key={s.id}
              swing={s}
              selecting={selected != null}
              selected={selected?.has(s.id) ?? false}
              onPress={() => onPress(s)}
              onLongPress={onLongPress && (() => onLongPress(s))}
            />
          ))}
          {item.swings.length === 1 && <View style={styles.tile} />}
        </View>
      )}
      ListEmptyComponent={
        <ThemedText themeColor="textSecondary">
          {swings.length > 0 ? 'No swings match this filter.' : empty}
        </ThemedText>
      }
    />
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
  onLongPress?: () => void;
}) {
  const theme = useTheme();
  const tags = notesSummary(swing.notes);
  const details = [
    tags || (swing.source && SOURCE_LABEL[swing.source]),
    swing.tempo ? formatTempoRatio(swing.tempo) : swing.durationMs && `${(swing.durationMs / 1000).toFixed(1)} s`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`Swing at ${formatClipTime(swing.createdAt)}${tags ? `, ${tags}` : ''}`}
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
        {swing.notes.favorite && <ThemedText style={styles.star}>★</ThemedText>}
        {swing.angle && (
          <View style={styles.badge}>
            <ThemedText style={styles.badgeText}>2 angles</ThemedText>
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
  list: { paddingHorizontal: Spacing.three, gap: Spacing.three },
  filters: { gap: Spacing.two },
  filterRow: { flexDirection: 'row', gap: Spacing.two },
  filterPanel: { gap: Spacing.two, alignItems: 'flex-start' },
  chipRow: { gap: Spacing.two },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  sectionHeader: { marginTop: Spacing.two },
  row: { flexDirection: 'row', gap: Spacing.three },
  tile: { flex: 1, gap: Spacing.one },
  thumb: { width: '100%', aspectRatio: 9 / 16, borderRadius: Spacing.two, overflow: 'hidden' },
  star: {
    position: 'absolute',
    top: Spacing.one,
    left: Spacing.two,
    color: '#FFD54F',
    fontSize: 22,
    lineHeight: 28,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
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
  badge: {
    position: 'absolute',
    left: Spacing.two,
    bottom: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  badgeText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  checkEmpty: { borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)' },
  checkMark: { color: '#fff', fontWeight: '700', lineHeight: 20 },
});

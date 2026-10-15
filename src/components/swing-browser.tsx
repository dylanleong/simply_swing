import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { Icon } from '@/components/icon';
import { Sheet, SheetRow } from '@/components/sheet';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  filterSwings,
  formatClipTime,
  formatSession,
  formatTempoRatio,
  formatTimeOfDay,
  groupSessions,
  NO_FILTER,
  type Swing,
  type SwingFilter,
} from '@/lib/swing-library';
import { CLUBS, notesSummary, RESULT_LABEL, SHOT_RESULTS } from '@/lib/swing-notes';

/** A range session is dozens of swings: three across keeps a session to a screen or two. */
const COLUMNS = 3;
const STAR = '#FFC83D';

type Row = { key: string; swings: Swing[] };

/**
 * The swing grid, grouped into practice sessions under sticky headers, with a filter (favourites,
 * club, result) that stays out of the way in a sheet. Used by the Swings tab and "compare with…".
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
  const theme = useTheme();
  const [filterOpen, setFilterOpen] = useState(false);
  const shown = useMemo(() => filterSwings(swings, filter), [swings, filter]);
  const sections = useMemo(
    () =>
      groupSessions(shown).map((session) => {
        const rows: Row[] = [];
        for (let i = 0; i < session.swings.length; i += COLUMNS) {
          const group = session.swings.slice(i, i + COLUMNS);
          rows.push({ key: group.map((s) => s.id).join('|'), swings: group });
        }
        return { key: `${session.start}`, title: formatSession(session), count: session.swings.length, data: rows };
      }),
    [shown]
  );
  const filtering = filter.club != null || filter.result != null || filter.favorites;
  const summary = [filter.favorites && '★ Favourites', filter.club, filter.result && RESULT_LABEL[filter.result]]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        stickySectionHeadersEnabled
        contentContainerStyle={{ paddingBottom: Spacing.four + bottomInset }}
        refreshing={refreshing}
        onRefresh={onRefresh}
        extraData={selected}
        ListHeaderComponent={
          swings.length > 0 ? (
            <View style={styles.filterBar}>
              <Chip
                variant="option"
                size="sm"
                icon="ion:filter"
                selected={filtering}
                label={filtering ? summary : 'Filter'}
                onPress={() => setFilterOpen(true)}
              />
              {filtering && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear filter"
                  hitSlop={8}
                  onPress={() => onFilterChange(NO_FILTER)}>
                  <Icon name="ion:close-circle" size={22} color={theme.textSecondary} />
                </Pressable>
              )}
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <View style={[styles.sectionHeader, { backgroundColor: theme.background }]}>
            <ThemedText type="smallBold">{section.title}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {`${section.count} swing${section.count === 1 ? '' : 's'}`}
            </ThemedText>
          </View>
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
            {Array.from({ length: COLUMNS - item.swings.length }, (_, i) => (
              <View key={i} style={styles.tile} />
            ))}
          </View>
        )}
        ListEmptyComponent={
          <ThemedText themeColor="textSecondary" style={styles.empty}>
            {swings.length > 0 ? 'No swings match this filter.' : empty}
          </ThemedText>
        }
      />

      <Sheet visible={filterOpen} onClose={() => setFilterOpen(false)} title="Show">
        <SheetRow
          icon="ion:star-outline"
          label="Favourites only"
          checked={filter.favorites}
          onPress={() => onFilterChange({ ...filter, favorites: !filter.favorites })}
        />
        <View style={styles.sheetSection}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Club
          </ThemedText>
          <View style={styles.wrap}>
            <Chip variant="option" size="sm" label="Any" selected={filter.club == null} onPress={() => onFilterChange({ ...filter, club: null })} />
            {CLUBS.map((c) => (
              <Chip
                key={c}
                variant="option"
                size="sm"
                label={c}
                selected={filter.club === c}
                onPress={() => onFilterChange({ ...filter, club: c })}
              />
            ))}
          </View>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Result
          </ThemedText>
          <View style={styles.wrap}>
            <Chip variant="option" size="sm" label="Any" selected={filter.result == null} onPress={() => onFilterChange({ ...filter, result: null })} />
            {SHOT_RESULTS.map((r) => (
              <Chip
                key={r}
                variant="option"
                size="sm"
                label={RESULT_LABEL[r]}
                selected={filter.result === r}
                onPress={() => onFilterChange({ ...filter, result: r })}
              />
            ))}
          </View>
          <View style={styles.sheetButtons}>
            <Chip label="Clear" fill onPress={() => onFilterChange(NO_FILTER)} />
            <Chip variant="primary" label={`Show ${shown.length}`} fill onPress={() => setFilterOpen(false)} />
          </View>
        </View>
      </Sheet>
    </>
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
  const badge = [tags, swing.tempo && formatTempoRatio(swing.tempo)].filter(Boolean).join(' · ');

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
        {swing.notes.favorite && (
          <View style={styles.star}>
            <Icon name="ion:star" size={16} color={STAR} />
          </View>
        )}
        {swing.angle && !selecting && (
          <View style={styles.angles}>
            <Icon name="ion:albums-outline" size={14} color="#fff" />
          </View>
        )}
        {badge ? (
          <View style={styles.badge}>
            <ThemedText style={styles.badgeText} numberOfLines={1}>
              {badge}
            </ThemedText>
          </View>
        ) : null}
        {selecting && (
          <View
            style={[
              styles.check,
              selected ? { backgroundColor: theme.accent, borderColor: theme.accent } : styles.checkEmpty,
            ]}>
            {selected && <Icon name="ion:checkmark" size={16} color="#fff" />}
          </View>
        )}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {formatTimeOfDay(swing.createdAt)}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  row: { flexDirection: 'row', gap: Spacing.two, paddingHorizontal: Spacing.three, marginBottom: Spacing.three },
  tile: { flex: 1, gap: Spacing.one },
  thumb: { width: '100%', aspectRatio: 9 / 16, borderRadius: Spacing.two, overflow: 'hidden' },
  star: {
    position: 'absolute',
    top: Spacing.one,
    left: Spacing.one,
    padding: 3,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  angles: {
    position: 'absolute',
    top: Spacing.one,
    right: Spacing.one,
    padding: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  badge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.one + 2,
    paddingVertical: Spacing.one,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  badgeText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  check: {
    position: 'absolute',
    top: Spacing.one,
    right: Spacing.one,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkEmpty: { borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.3)' },
  empty: { paddingHorizontal: Spacing.three },
  sheetSection: { paddingHorizontal: Spacing.four, gap: Spacing.two, paddingTop: Spacing.two },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginBottom: Spacing.two },
  sheetButtons: { flexDirection: 'row', gap: Spacing.two, paddingTop: Spacing.two },
});

import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MAX_CONTENT_WIDTH } from '@/lib/layout';
import { CLUBS, RESULT_LABEL, SHOT_RESULTS, type Club, type ShotResult } from '@/lib/swing-notes';

/** Two even rows of four, so the buttons line up and are easy to hit. */
const RESULT_ROWS = [SHOT_RESULTS.slice(0, 4), SHOT_RESULTS.slice(4)];

/** One tap per shot: what the ball did. Tapping the selected result clears it. */
export function ResultChips({
  value,
  onChange,
  onDark = false,
  size = 'md',
}: {
  value: ShotResult | null;
  onChange: (result: ShotResult | null) => void;
  onDark?: boolean;
  size?: 'md' | 'lg';
}) {
  return (
    <View style={styles.rows}>
      {RESULT_ROWS.map((row) => (
        <View key={row[0]} style={styles.row}>
          {row.map((r) => (
            <Chip
              key={r}
              variant="option"
              fill
              size={size}
              onDark={onDark}
              icon={r === 'good' ? 'ion:checkmark' : undefined}
              label={RESULT_LABEL[r]}
              selected={value === r}
              onPress={() => onChange(value === r ? null : r)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/** Pick the club in hand (or none). */
export function ClubPicker({
  visible,
  value,
  onChange,
  onClose,
}: {
  visible: boolean;
  value: Club | null;
  onChange: (club: Club | null) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const pick = (club: Club | null) => {
    onChange(club);
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.card, { backgroundColor: theme.background }]}>
          <ThemedText type="subtitle">Club</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Swings you save are tagged with it, so you can filter by club later.
          </ThemedText>
          <View style={styles.grid}>
            {CLUBS.map((c) => (
              <Chip key={c} variant="option" label={c} selected={value === c} onPress={() => pick(c)} style={styles.club} />
            ))}
          </View>
          <Chip variant="option" label="No club" selected={value === null} onPress={() => pick(null)} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rows: { gap: Spacing.two, alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: Spacing.two },
  club: { minWidth: 56 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: Spacing.four },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
    alignItems: 'flex-start',
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});

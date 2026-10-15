import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CLUBS, RESULT_LABEL, SHOT_RESULTS, type Club, type ShotResult } from '@/lib/swing-notes';

/** One tap per shot: what the ball did. Tapping the selected result clears it. */
export function ResultChips({
  value,
  onChange,
  onDark = false,
}: {
  value: ShotResult | null;
  onChange: (result: ShotResult | null) => void;
  onDark?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      {SHOT_RESULTS.map((r) => (
        <Chip
          key={r}
          compact
          onDark={onDark}
          label={RESULT_LABEL[r]}
          selected={value === r}
          onPress={() => onChange(value === r ? null : r)}
        />
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
              <Chip key={c} label={c} selected={value === c} onPress={() => pick(c)} />
            ))}
          </View>
          <Chip label="No club" selected={value === null} onPress={() => pick(null)} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: Spacing.two },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: Spacing.four },
  card: { borderRadius: Spacing.four, padding: Spacing.four, gap: Spacing.three, alignItems: 'flex-start' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
});

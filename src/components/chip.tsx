import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A rounded button for control rows. `onDark` is for chips drawn over the camera or a video. */
export function Chip({
  label,
  onPress,
  selected = false,
  danger = false,
  onDark = false,
  compact = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  danger?: boolean;
  onDark?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const idle = onDark ? 'rgba(0,0,0,0.6)' : theme.backgroundElement;
  const background = selected ? theme.accent : idle;
  const color = selected || onDark ? '#fff' : danger ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={compact ? 4 : 0}
      style={({ pressed }) => [
        styles.chip,
        compact && styles.compact,
        { backgroundColor: background, opacity: pressed ? 0.7 : 1 },
        // Over a dark picture a dark chip disappears; an outline keeps it a button.
        onDark && !selected && styles.outlined,
      ]}>
      <ThemedText style={[{ color }, compact && styles.compactText]}>{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: Spacing.four },
  compact: { paddingHorizontal: Spacing.two + 2, paddingVertical: Spacing.one + 2 },
  compactText: { fontSize: 14, lineHeight: 18 },
  outlined: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.55)' },
});

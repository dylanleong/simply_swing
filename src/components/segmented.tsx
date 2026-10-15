import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type SegmentedOption<T> = { value: T; label: string; disabled?: boolean };

/** A row of mutually exclusive choices. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.row, { borderColor: theme.border }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: o.disabled }}
            disabled={o.disabled}
            onPress={() => onChange(o.value)}
            style={[
              styles.segment,
              selected && { backgroundColor: theme.accentSoft, borderColor: theme.accent },
              o.disabled && styles.disabled,
            ]}>
            <ThemedText type="smallBold" style={selected ? { color: theme.accent } : undefined}>
              {o.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same language as option chips: outlined, the choice tinted with the accent.
  row: { flexDirection: 'row', borderRadius: Spacing.three, borderWidth: 1, padding: Spacing.half },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three - 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  disabled: { opacity: 0.35 },
});

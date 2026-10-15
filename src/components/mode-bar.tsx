import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type Mode<T extends string> = { value: T; label: string; icon: IconName };

/**
 * Switches what the tray above it shows. Styled as navigation (icon + label, an indicator on the
 * active one, no pill), so it never reads as one more row of options.
 */
export function ModeBar<T extends string>({
  modes,
  value,
  onChange,
}: {
  modes: readonly Mode<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { borderTopColor: theme.border }]}>
      {modes.map((m) => {
        const active = m.value === value;
        const color = active ? theme.accent : theme.textSecondary;
        return (
          <Pressable
            key={m.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(m.value)}
            style={styles.tab}>
            <View style={[styles.indicator, active && { backgroundColor: theme.accent }]} />
            <Icon name={m.icon} size={22} color={color} />
            <ThemedText style={[styles.label, { color }]}>{m.label}</ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingBottom: Spacing.one, gap: 2 },
  indicator: { alignSelf: 'stretch', height: 3, marginHorizontal: Spacing.four, borderRadius: 2, marginBottom: Spacing.one + 2 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
});

import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * One look per role, so options never look like actions or navigation:
 * - `option`: a choice or toggle. Outlined; selected = accent outline, tint and text.
 * - `action`: does something. Filled neutral.
 * - `primary`: the one main action on a screen. Filled accent.
 * - `danger`: destroys something. Neutral with red text.
 * `onDark` is for chips over the camera or a video.
 */
export type ChipVariant = 'option' | 'action' | 'primary' | 'danger';

export function Chip({
  label,
  onPress,
  variant = 'action',
  selected = false,
  onDark = false,
  size = 'md',
  icon,
  fill = false,
  style,
  accessibilityLabel,
  hitSlop,
}: {
  label: string;
  onPress: () => void;
  variant?: ChipVariant;
  selected?: boolean;
  onDark?: boolean;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  /** Share a row's width equally with its siblings. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** For a small chip that stands alone (not in a row of them): reach 44 pt without growing. */
  hitSlop?: number;
}) {
  const theme = useTheme();
  let background: string = theme.backgroundElement;
  let border = 'transparent';
  let color: string = theme.text;
  if (variant === 'option') {
    background = selected ? theme.accentSoft : 'transparent';
    border = selected ? theme.accent : theme.border;
    color = selected ? theme.accent : theme.text;
    if (onDark) {
      background = selected ? theme.accent : 'rgba(0,0,0,0.55)';
      border = selected ? theme.accent : 'rgba(255,255,255,0.55)';
      color = '#fff';
    }
  } else if (variant === 'primary') {
    background = theme.accent;
    color = '#fff';
  } else if (variant === 'danger') {
    color = theme.danger;
  } else if (onDark) {
    background = 'rgba(0,0,0,0.6)';
    color = '#fff';
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={variant === 'option' ? { selected } : undefined}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        styles.chip,
        styles[size],
        fill && styles.fill,
        { backgroundColor: background, borderColor: border, opacity: pressed ? 0.6 : 1 },
        style,
      ]}>
      <View style={styles.content}>
        {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} color={color} />}
        {/* A filled chip's label spans the chip and centres itself: its width then never depends on a
            text measurement, which Android has got wrong for one word after a rotation ("Pus"). */}
        <ThemedText
          numberOfLines={1}
          style={[styles.text, size === 'sm' && styles.smallText, fill && !icon && styles.fillText, { color }]}>
          {label}
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  sm: { minHeight: 32, paddingHorizontal: Spacing.two + 4 },
  md: { minHeight: 40, paddingHorizontal: Spacing.three },
  lg: { minHeight: 48, paddingHorizontal: Spacing.three, borderRadius: Spacing.three },
  fill: { flex: 1, paddingHorizontal: Spacing.one },
  fillText: { flexGrow: 1, textAlign: 'center' },
  content: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center', gap: Spacing.one + 2 },
  text: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  smallText: { fontSize: 13, lineHeight: 18 },
});

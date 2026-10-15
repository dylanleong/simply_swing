import { Pressable, StyleSheet } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';

/**
 * A round icon-only button. `filled` is the one big button in a row (play / pause); `active`
 * tints it as switched on; `onDark` is for buttons over the camera or a video.
 */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 44,
  filled = false,
  active = false,
  onDark = false,
  disabled = false,
  tint,
}: {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  filled?: boolean;
  active?: boolean;
  onDark?: boolean;
  disabled?: boolean;
  /** Icon colour override (e.g. a gold favourite star). */
  tint?: string;
}) {
  const theme = useTheme();
  const background = filled ? theme.text : onDark ? 'rgba(0,0,0,0.55)' : 'transparent';
  const color = tint ?? (filled ? theme.background : active ? theme.accent : onDark ? '#fff' : theme.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 },
      ]}>
      <Icon name={icon} size={Math.round(size * (filled ? 0.5 : 0.55))} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center' },
});

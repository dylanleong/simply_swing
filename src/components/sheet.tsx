import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A bottom sheet: the home for options that aren't used often enough to sit on screen. */
export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: theme.background }]}>
        <View style={[styles.handle, { backgroundColor: theme.border }]} />
        {title && (
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.title}>
            {title.toUpperCase()}
          </ThemedText>
        )}
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** One row in a sheet: an action, or a toggle when `checked` is given. */
export function SheetRow({
  icon,
  label,
  onPress,
  danger = false,
  checked,
  detail,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  danger?: boolean;
  checked?: boolean;
  detail?: string;
  /** Greyed out and ignores taps (e.g. while an export is running). */
  disabled?: boolean;
}) {
  const theme = useTheme();
  const color = danger ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole={checked === undefined ? 'button' : 'switch'}
      accessibilityState={checked === undefined ? { disabled } : { checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.backgroundElement : 'transparent', opacity: disabled ? 0.4 : 1 },
      ]}>
      <Icon name={icon} size={22} color={color} />
      <ThemedText style={[styles.rowLabel, { color }]}>{label}</ThemedText>
      {detail && (
        <ThemedText type="small" themeColor="textSecondary">
          {detail}
        </ThemedText>
      )}
      {checked !== undefined && (
        <Icon name={checked ? 'ion:checkmark-circle' : 'ion:ellipse-outline'} size={22} color={checked ? theme.accent : theme.border} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    paddingTop: Spacing.two,
    maxHeight: '80%',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: Spacing.two },
  title: { paddingHorizontal: Spacing.four, paddingVertical: Spacing.two, letterSpacing: 0.8 },
  content: { paddingBottom: Spacing.three },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    minHeight: 52,
  },
  rowLabel: { flex: 1, fontSize: 16, lineHeight: 22 },
});

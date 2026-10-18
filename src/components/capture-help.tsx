import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MAX_CONTENT_WIDTH } from '@/lib/layout';

/** Three steps; everything else is in Help. */
const steps = (lookbackSec: number): { title: string; body: string }[] => [
  {
    title: 'Set up the phone',
    body: 'Tripod about 3 m away, camera at hand height, upright and level. Down the line or face on.',
  },
  {
    title: 'Fit the golfer box',
    body: 'Drag the dashed box over where you stand and swing; drag a corner to resize it.',
  },
  {
    title: 'Hit balls',
    body: `Hitting a ball saves the swing and replays it in slow motion. No ball? Tap SAVE to keep the last ${lookbackSec} seconds.`,
  },
];

export function CaptureHelp({
  visible,
  onClose,
  lookbackSec,
}: {
  visible: boolean;
  onClose: () => void;
  lookbackSec: number;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <ScrollView contentContainerStyle={styles.content}>
            <ThemedText type="subtitle" style={styles.title}>
              How it works
            </ThemedText>
            {steps(lookbackSec).map((step, i) => (
              <View key={step.title} style={styles.step}>
                <View style={[styles.number, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText style={styles.numberText}>{i + 1}</ThemedText>
                </View>
                <View style={styles.stepText}>
                  <ThemedText type="smallBold">{step.title}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {step.body}
                  </ThemedText>
                </View>
              </View>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onClose();
              router.push('/help');
            }}
            hitSlop={8}
            style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText style={{ color: theme.textSecondary, fontWeight: '600' }}>More help</ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.button, { backgroundColor: theme.accent, opacity: pressed ? 0.7 : 1 }]}>
            <ThemedText style={styles.buttonText}>Got it</ThemedText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  card: { borderRadius: Spacing.four, maxHeight: '85%', overflow: 'hidden', width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
  link: { alignItems: 'center', paddingVertical: Spacing.two },
  content: { padding: Spacing.four, gap: Spacing.three },
  title: { fontSize: 26, lineHeight: 32 },
  step: { flexDirection: 'row', gap: Spacing.three },
  number: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontWeight: '700', fontSize: 14, lineHeight: 18 },
  stepText: { flex: 1, gap: Spacing.half },
  button: {
    margin: Spacing.four,
    marginTop: 0,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '700' },
});

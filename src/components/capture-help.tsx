import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const steps = (lookbackSec: number): { title: string; body: string }[] => [
  {
    title: 'Set up the phone',
    body:
      'Tripod about 3 m away, camera at hand height, upright and level (a bar at the top warns if it’s ' +
      'tilted). Down the line: behind you, aiming along your target line. Face on: square to your chest.',
  },
  {
    title: 'Fit the golfer box',
    body:
      'Drag the dashed box over where you stand and swing; drag a corner to resize it. It flashes ' +
      'green when it sees a swing (standing still is fine; it watches for movement).',
  },
  {
    title: 'Just hit balls',
    body:
      'The camera is always recording. With Auto on, hitting a ball saves the swing and plays it back ' +
      'in slow motion. Neighbours’ shots are ignored because nobody moved in your box.',
  },
  {
    title: 'No ball? Save it yourself',
    body:
      'After a practice swing, tap SAVE (or press a volume button / Bluetooth remote) to keep the ' +
      `last ${lookbackSec} seconds.`,
  },
  {
    title: 'Tag it and review it',
    body:
      'Pick your club with the Club button; after each shot, tap what the ball did. Open a swing to ' +
      'replay it slowly, draw on it, and compare it with your best.',
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
                <View style={[styles.number, { backgroundColor: theme.accent }]}>
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
            style={({ pressed }) => [styles.link, { opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText style={{ color: theme.accent, fontWeight: '600' }}>More help & golf tips</ThemedText>
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
  card: { borderRadius: Spacing.four, maxHeight: '85%', overflow: 'hidden' },
  link: { alignItems: 'center', paddingVertical: Spacing.two },
  content: { padding: Spacing.four, gap: Spacing.three },
  title: { fontSize: 26, lineHeight: 32 },
  step: { flexDirection: 'row', gap: Spacing.three },
  number: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: '#fff', fontWeight: '700', fontSize: 14, lineHeight: 18 },
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

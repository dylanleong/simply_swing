import { StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { IconButton } from '@/components/icon-button';
import { Scrubber } from '@/components/scrubber';
import { Spacing } from '@/constants/theme';

/** Slowest first: a tap steps through them. */
const SPEEDS = [0.125, 0.25, 0.5, 1] as const;
const SPEED_LABEL: Record<number, string> = { 0.125: '⅛×', 0.25: '¼×', 0.5: '½×', 1: '1×' };

/**
 * Timeline and playback controls, always in the same place on review and compare: impact, frame
 * back, play / pause, frame forward, speed.
 */
export function Transport({
  duration,
  position,
  impact,
  isPlaying,
  rate,
  onSeek,
  onTogglePlay,
  onStep,
  onRate,
  onPause,
}: {
  duration: number;
  position: number;
  impact: number | null;
  isPlaying: boolean;
  rate: number;
  onSeek: (seconds: number) => void;
  onTogglePlay: () => void;
  onStep: (frames: number) => void;
  onRate: (rate: number) => void;
  onPause: () => void;
}) {
  const nextRate = SPEEDS[(SPEEDS.indexOf(rate as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
  return (
    <View style={styles.container}>
      <Scrubber duration={duration} position={position} impact={impact} onSeek={onSeek} onScrubStart={onPause} />
      <View style={styles.row}>
        <IconButton
          icon="ion:locate-outline"
          accessibilityLabel="Jump to impact"
          disabled={impact == null}
          onPress={() => impact != null && onSeek(impact)}
        />
        <IconButton icon="mci:step-backward" accessibilityLabel="Back one frame" onPress={() => onStep(-1)} />
        <IconButton
          icon={isPlaying ? 'ion:pause' : 'ion:play'}
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
          filled
          size={56}
          onPress={onTogglePlay}
        />
        <IconButton icon="mci:step-forward" accessibilityLabel="Forward one frame" onPress={() => onStep(1)} />
        <Chip
          variant="option"
          size="sm"
          label={SPEED_LABEL[rate] ?? `${rate}×`}
          accessibilityLabel={`Speed ${SPEED_LABEL[rate]}. Change speed`}
          onPress={() => onRate(nextRate)}
          style={styles.speed}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.one },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.one },
  speed: { width: 56 },
});

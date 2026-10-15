import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

const THUMB = 16;

/**
 * The clip's timeline: drag or tap to seek. A tick marks the impact so it's one drag away.
 * Children never take touches, so locationX is always relative to the track.
 */
export function Scrubber({
  duration,
  position,
  impact,
  onSeek,
  onScrubStart,
}: {
  duration: number;
  position: number;
  impact: number | null;
  onSeek: (seconds: number) => void;
  onScrubStart?: () => void;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const lastSeek = useRef(0);

  const timeAt = (e: GestureResponderEvent) =>
    width > 0 ? Math.min(duration, Math.max(0, (e.nativeEvent.locationX / width) * duration)) : 0;

  const seek = (t: number, force = false) => {
    setDragging(t);
    // Seeking on every move floods the player; ~30 a second keeps the picture following the finger.
    const now = Date.now();
    if (force || now - lastSeek.current > 33) {
      lastSeek.current = now;
      onSeek(t);
    }
  };

  const shown = dragging ?? position;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;

  return (
    <View
      style={styles.hit}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        onScrubStart?.();
        seek(timeAt(e), true);
      }}
      onResponderMove={(e) => seek(timeAt(e))}
      onResponderRelease={(e) => {
        onSeek(timeAt(e));
        setDragging(null);
      }}
      accessibilityRole="adjustable"
      accessibilityLabel="Position in the swing">
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[styles.track, { backgroundColor: theme.border }]} />
        <View style={[styles.track, styles.progress, { width: `${fraction * 100}%`, backgroundColor: theme.accent }]} />
        {impact != null && duration > 0 && (
          <View style={[styles.impact, { left: `${(impact / duration) * 100}%`, backgroundColor: theme.text }]} />
        )}
        <View
          style={[
            styles.thumb,
            { left: fraction * width - THUMB / 2, backgroundColor: theme.text, borderColor: theme.background },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 32, justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, top: 14, height: 4, borderRadius: 2 },
  progress: { right: undefined },
  impact: { position: 'absolute', top: 8, width: 3, height: 16, marginLeft: -1.5, borderRadius: 1.5 },
  thumb: { position: 'absolute', top: 8, width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 2 },
});

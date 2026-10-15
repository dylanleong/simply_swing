import { VideoView, type VideoPlayer } from 'expo-video';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DrawingOverlay, type DrawTool } from '@/components/drawing-overlay';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { fitRect, type Shape } from '@/lib/swing-notes';

/** One clip in review or compare: the video, its drawings and grid, an optional corner label. */
export function VideoPane({
  player,
  label,
  mirrored = false,
  grid = false,
  shapes = [],
  tool = null,
  onAddShape,
}: {
  player: VideoPlayer;
  label?: string;
  mirrored?: boolean;
  grid?: boolean;
  shapes?: Shape[];
  tool?: DrawTool | null;
  onAddShape?: (shape: Shape) => void;
}) {
  // The label sits on the picture's corner, not in the letterbox bars around it.
  const [frame, setFrame] = useState({ x: 0, y: 0 });
  return (
    <View
      style={styles.pane}
      onLayout={(e) => {
        const r = fitRect(e.nativeEvent.layout.width, e.nativeEvent.layout.height);
        setFrame({ x: r.x, y: r.y });
      }}>
      {/* textureView: a SurfaceView ignores the mirror transform on Android. */}
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, mirrored && styles.mirrored]}
        contentFit="contain"
        nativeControls={false}
        surfaceType="textureView"
      />
      <DrawingOverlay
        shapes={shapes}
        tool={onAddShape ? tool : null}
        mirrored={mirrored}
        grid={grid}
        onAdd={(s) => onAddShape?.(s)}
      />
      {label ? (
        <ThemedText
          style={[styles.label, { top: frame.y + Spacing.two, left: frame.x + Spacing.two }]}
          pointerEvents="none">
          {label}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1, overflow: 'hidden' },
  mirrored: { transform: [{ scaleX: -1 }] },
  label: {
    position: 'absolute',
    color: '#fff',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
});

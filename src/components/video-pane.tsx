import { VideoView, type VideoPlayer } from 'expo-video';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/chip';
import { DrawingOverlay, type DrawTool } from '@/components/drawing-overlay';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { fitRect, type Shape } from '@/lib/swing-notes';
import { DEFAULT_CLIP_ASPECT } from '@/lib/swing-library';

/** One clip in review or compare: the video, its drawings and grid, an optional corner label. */
export function VideoPane({
  player,
  label,
  aspect = DEFAULT_CLIP_ASPECT,
  mirrored = false,
  grid = false,
  shapes = [],
  tool = null,
  onAddShape,
  onLabelPress,
  solo = false,
  failed = false,
  failedAction,
}: {
  player: VideoPlayer;
  label?: string;
  /** The clip's upright shape (width / height), so the label and drawings sit on the picture. */
  aspect?: number;
  mirrored?: boolean;
  grid?: boolean;
  shapes?: Shape[];
  tool?: DrawTool | null;
  onAddShape?: (shape: Shape) => void;
  /** Makes the label a button (show this clip alone, or both again). */
  onLabelPress?: () => void;
  /** This clip is shown alone; the label offers to go back to both. */
  solo?: boolean;
  /** The player couldn't open the clip (half-written or corrupt): a message instead of a black pane. */
  failed?: boolean;
  /** What to offer then (review: delete the swing). */
  failedAction?: { label: string; onPress: () => void };
}) {
  // The label sits on the picture's corner, not in the letterbox bars around it.
  const [frame, setFrame] = useState({ x: 0, y: 0 });
  return (
    <View
      style={styles.pane}
      onLayout={(e) => {
        const r = fitRect(e.nativeEvent.layout.width, e.nativeEvent.layout.height, aspect);
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
        aspect={aspect}
        onAdd={(s) => onAddShape?.(s)}
      />
      {failed && (
        <View style={styles.failed}>
          <Icon name="ion:alert-circle-outline" size={32} color="#fff" />
          <ThemedText style={styles.failedText}>Can&apos;t play this clip</ThemedText>
          <ThemedText type="small" style={styles.failedDetail}>
            It may not have finished saving.
          </ThemedText>
          {failedAction && <Chip variant="danger" label={failedAction.label} onPress={failedAction.onPress} />}
        </View>
      )}
      {label ? (
        <Pressable
          accessibilityRole={onLabelPress ? 'button' : undefined}
          accessibilityLabel={onLabelPress ? (solo ? 'Show both angles' : `Show ${label} only`) : label}
          disabled={!onLabelPress}
          onPress={onLabelPress}
          hitSlop={8}
          style={[styles.label, { top: frame.y + Spacing.two, left: frame.x + Spacing.two }]}>
          <ThemedText style={styles.labelText} maxFontSizeMultiplier={1.3}>
            {label}
          </ThemedText>
          {onLabelPress && <Icon name={solo ? 'ion:contract-outline' : 'ion:expand-outline'} size={14} color="#fff" />}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1, overflow: 'hidden' },
  mirrored: { transform: [{ scaleX: -1 }] },
  label: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
  },
  labelText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  failed: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    backgroundColor: '#000',
  },
  failedText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  failedDetail: { color: 'rgba(255,255,255,0.75)', textAlign: 'center' },
});

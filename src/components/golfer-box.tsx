import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { MIN_ROI_SIZE, type RoiBounds } from '@/lib/capture-settings';
import type { NormalizedRect } from '../../modules/swing-capture';

/** On-screen rectangle of the camera image (the preview is letterboxed inside its view). */
export type PreviewFrame = { left: number; top: number; width: number; height: number };

type Props = {
  frame: PreviewFrame;
  /** Vertical band the box may occupy (keeps handles clear of the top and bottom controls). */
  bounds: RoiBounds;
  roi: NormalizedRect;
  /** Called once per drag, when the finger lifts. */
  onChange: (roi: NormalizedRect) => void;
  /** Swing-level motion right now: outline turns green. */
  active: boolean;
  activeColor: string;
};

const HANDLE = 44; // touch target
const DOT = 18; // visible handle

/** Dashed golfer box over the preview: drag inside to move, drag a corner to resize. */
export function GolferBox({ frame, bounds, roi, onChange, active, activeColor }: Props) {
  const { minY, maxY } = bounds;
  const x = useSharedValue(roi.x);
  const y = useSharedValue(roi.y);
  const w = useSharedValue(roi.width);
  const h = useSharedValue(roi.height);
  const start = useSharedValue<NormalizedRect>(roi);

  // Follow external changes (loaded settings, reset).
  useEffect(() => {
    x.set(roi.x);
    y.set(roi.y);
    w.set(roi.width);
    h.set(roi.height);
  }, [roi, x, y, w, h]);

  const commit = (nx: number, ny: number, nw: number, nh: number) => onChange({ x: nx, y: ny, width: nw, height: nh });

  const begin = () => {
    'worklet';
    start.set({ x: x.get(), y: y.get(), width: w.get(), height: h.get() });
  };
  const end = () => {
    'worklet';
    scheduleOnRN(commit, x.get(), y.get(), w.get(), h.get());
  };

  const move = Gesture.Pan()
    .onStart(begin)
    .onUpdate((e) => {
      const s = start.get();
      x.set(Math.min(1 - s.width, Math.max(0, s.x + e.translationX / frame.width)));
      y.set(Math.min(maxY - s.height, Math.max(minY, s.y + e.translationY / frame.height)));
    })
    .onEnd(end);

  const resize = (left: boolean, top: boolean) =>
    Gesture.Pan()
      .onStart(begin)
      .onUpdate((e) => {
        const s = start.get();
        const dx = e.translationX / frame.width;
        const dy = e.translationY / frame.height;
        if (left) {
          const nx = Math.min(s.x + s.width - MIN_ROI_SIZE, Math.max(0, s.x + dx));
          x.set(nx);
          w.set(s.width + s.x - nx);
        } else {
          w.set(Math.min(1 - s.x, Math.max(MIN_ROI_SIZE, s.width + dx)));
        }
        if (top) {
          const ny = Math.min(s.y + s.height - MIN_ROI_SIZE, Math.max(minY, s.y + dy));
          y.set(ny);
          h.set(s.height + s.y - ny);
        } else {
          h.set(Math.min(maxY - s.y, Math.max(MIN_ROI_SIZE, s.height + dy)));
        }
      })
      .onEnd(end);

  const boxStyle = useAnimatedStyle(() => ({
    left: frame.left + x.get() * frame.width,
    top: frame.top + y.get() * frame.height,
    width: w.get() * frame.width,
    height: h.get() * frame.height,
  }));

  return (
    <>
      <GestureDetector gesture={move}>
        <Animated.View
          accessibilityLabel="Golfer box. Drag to move."
          style={[styles.box, active && { borderColor: activeColor }, boxStyle]}>
          <Text style={styles.label}>Golfer box</Text>
        </Animated.View>
      </GestureDetector>
      {(
        [
          [true, true],
          [false, true],
          [true, false],
          [false, false],
        ] as const
      ).map(([left, top]) => (
        <Corner
          key={`${left}-${top}`}
          gesture={resize(left, top)}
          frame={frame}
          x={left ? x : null}
          xEnd={left ? null : { x, w }}
          y={top ? y : null}
          yEnd={top ? null : { y, h }}
        />
      ))}
    </>
  );
}

/** A corner handle that follows one corner of the box. */
function Corner({
  gesture,
  frame,
  x,
  xEnd,
  y,
  yEnd,
}: {
  gesture: ReturnType<typeof Gesture.Pan>;
  frame: PreviewFrame;
  x: SharedValue<number> | null;
  xEnd: { x: SharedValue<number>; w: SharedValue<number> } | null;
  y: SharedValue<number> | null;
  yEnd: { y: SharedValue<number>; h: SharedValue<number> } | null;
}) {
  const style = useAnimatedStyle(() => {
    const nx = x ? x.get() : xEnd!.x.get() + xEnd!.w.get();
    const ny = y ? y.get() : yEnd!.y.get() + yEnd!.h.get();
    return {
      left: frame.left + nx * frame.width - HANDLE / 2,
      top: frame.top + ny * frame.height - HANDLE / 2,
    };
  });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View accessibilityLabel="Resize golfer box" style={[styles.handle, style]}>
        <Animated.View style={styles.dot} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.7)',
    borderRadius: 8,
    alignItems: 'center',
  },
  label: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 6,
    borderRadius: 4,
    overflow: 'hidden',
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.4)',
  },
});

import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import {
  angleDegrees,
  CLIP_ASPECT,
  extendToEdges,
  fitRect,
  type Point,
  type Rect,
  type Shape,
} from '@/lib/swing-notes';

export type DrawTool = 'line' | 'plane' | 'circle' | 'angle';

const SHAPE_COLOR = '#FFEB3B';
const DRAFT_COLOR = '#FFFFFF';
const GRID_COLOR = 'rgba(255,255,255,0.28)';
const STROKE = 3;
const GRID_COLUMNS = 6;
const GRID_ROWS = 10;
/** Drags shorter than this (fraction of the picture width) count as taps. */
const MIN_DRAG = 0.02;

/**
 * Lines, planes, circles and angles drawn over a clip, pinned to the picture (not the screen) so they
 * stay put across layouts. Interactive only while a [tool] is chosen. [mirrored] flips the drawing
 * with the video; shapes are stored unmirrored. [aspect] is the picture's width / height.
 */
export function DrawingOverlay({
  shapes,
  tool,
  mirrored = false,
  grid = false,
  aspect = CLIP_ASPECT,
  onAdd,
}: {
  shapes: Shape[];
  tool: DrawTool | null;
  mirrored?: boolean;
  grid?: boolean;
  aspect?: number;
  onAdd: (shape: Shape) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** The shape being drawn, following the finger. */
  const [draft, setDraft] = useState<Shape | null>(null);
  /** Angle tool: first arm done, waiting for the second. */
  const [halfAngle, setHalfAngle] = useState<{ vertex: Point; a: Point } | null>(null);
  // Switching tools mid-angle drops the half-drawn arm.
  const pendingAngle = tool === 'angle' ? halfAngle : null;
  // A ref, not state: a quick tap's release arrives before a re-render would expose it.
  const start = useRef<Point | null>(null);
  const rect = fitRect(size.width, size.height, aspect);

  const toPoint = (e: GestureResponderEvent): Point => {
    const x = (e.nativeEvent.locationX - rect.x) / rect.width;
    const y = (e.nativeEvent.locationY - rect.y) / rect.height;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp(mirrored ? 1 - x : x), clamp(y)];
  };

  const shapeFor = (from: Point, to: Point): Shape | null => {
    if (pendingAngle) return { kind: 'angle', vertex: pendingAngle.vertex, a: pendingAngle.a, b: to };
    switch (tool) {
      case 'line':
        return { kind: 'line', a: from, b: to };
      case 'plane':
        return { kind: 'plane', a: from, b: to };
      case 'circle':
        return { kind: 'circle', center: from, edge: to };
      case 'angle':
        return { kind: 'line', a: from, b: to };
      default:
        return null;
    }
  };

  const onGrant = (e: GestureResponderEvent) => {
    if (!pendingAngle && halfAngle) setHalfAngle(null);
    const p = toPoint(e);
    start.current = p;
    setDraft(shapeFor(p, p));
  };

  const onMove = (e: GestureResponderEvent) => {
    if (start.current) setDraft(shapeFor(start.current, toPoint(e)));
  };

  const onRelease = (e: GestureResponderEvent) => {
    const end = toPoint(e);
    const from = start.current;
    start.current = null;
    setDraft(null);
    if (!from) return;
    if (pendingAngle) {
      // Second arm: a tap or a drag, either way it ends where the finger lifts.
      onAdd({ kind: 'angle', vertex: pendingAngle.vertex, a: pendingAngle.a, b: end });
      setHalfAngle(null);
      return;
    }
    if (Math.hypot((end[0] - from[0]) * aspect, end[1] - from[1]) < MIN_DRAG) return;
    if (tool === 'angle') {
      setHalfAngle({ vertex: from, a: end });
      return;
    }
    const shape = shapeFor(from, end);
    if (shape) onAdd(shape);
  };

  const pendingShape: Shape | null =
    pendingAngle && !draft ? { kind: 'line', a: pendingAngle.vertex, b: pendingAngle.a } : null;

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={tool ? 'auto' : 'none'}
      onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      onStartShouldSetResponder={() => tool != null}
      onMoveShouldSetResponder={() => tool != null}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={onRelease}>
      {/* Children never take touches, so locationX/Y stay relative to this view. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {grid && rect.width > 0 && <Grid rect={rect} />}
        {shapes.map((s, i) => (
          <ShapeView key={i} shape={s} rect={rect} aspect={aspect} mirrored={mirrored} color={SHAPE_COLOR} />
        ))}
        {pendingShape && <ShapeView shape={pendingShape} rect={rect} aspect={aspect} mirrored={mirrored} color={DRAFT_COLOR} />}
        {draft && <ShapeView shape={draft} rect={rect} aspect={aspect} mirrored={mirrored} color={DRAFT_COLOR} />}
      </View>
    </View>
  );
}

function Grid({ rect }: { rect: Rect }) {
  const lines = [];
  for (let i = 1; i < GRID_COLUMNS; i++) {
    lines.push(
      <View
        key={`c${i}`}
        style={[styles.gridLine, { left: rect.x + (rect.width * i) / GRID_COLUMNS, top: rect.y, width: 1, height: rect.height }]}
      />
    );
  }
  for (let i = 1; i < GRID_ROWS; i++) {
    lines.push(
      <View
        key={`r${i}`}
        style={[styles.gridLine, { top: rect.y + (rect.height * i) / GRID_ROWS, left: rect.x, height: 1, width: rect.width }]}
      />
    );
  }
  return <>{lines}</>;
}

function ShapeView({
  shape,
  rect,
  aspect,
  mirrored,
  color,
}: {
  shape: Shape;
  rect: Rect;
  aspect: number;
  mirrored: boolean;
  color: string;
}) {
  const px = (p: Point): Point => [rect.x + (mirrored ? 1 - p[0] : p[0]) * rect.width, rect.y + p[1] * rect.height];
  switch (shape.kind) {
    case 'line':
      return <Segment from={px(shape.a)} to={px(shape.b)} color={color} />;
    case 'plane': {
      const [a, b] = extendToEdges(shape.a, shape.b);
      return <Segment from={px(a)} to={px(b)} color={color} />;
    }
    case 'circle': {
      const [cx, cy] = px(shape.center);
      const [ex, ey] = px(shape.edge);
      const r = Math.hypot(ex - cx, ey - cy);
      return (
        <View
          style={{
            position: 'absolute',
            left: cx - r,
            top: cy - r,
            width: r * 2,
            height: r * 2,
            borderRadius: r,
            borderWidth: STROKE,
            borderColor: color,
          }}
        />
      );
    }
    case 'angle': {
      const v = px(shape.vertex);
      const degrees = angleDegrees(shape, aspect);
      return (
        <>
          <Segment from={v} to={px(shape.a)} color={color} />
          <Segment from={v} to={px(shape.b)} color={color} />
          <ThemedText style={[styles.angleLabel, { left: v[0] + 8, top: v[1] - 28, color }]}>
            {`${Math.round(degrees)}°`}
          </ThemedText>
        </>
      );
    }
  }
}

/** A straight stroke between two screen points: a thin view, rotated about its centre. */
function Segment({ from, to, color }: { from: Point; to: Point; color: string }) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  return (
    <View
      style={{
        position: 'absolute',
        left: (from[0] + to[0]) / 2 - length / 2,
        top: (from[1] + to[1]) / 2 - STROKE / 2,
        width: length,
        height: STROKE,
        borderRadius: STROKE / 2,
        backgroundColor: color,
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

const styles = StyleSheet.create({
  gridLine: { position: 'absolute', backgroundColor: GRID_COLOR },
  angleLabel: {
    position: 'absolute',
    fontWeight: '800',
    fontSize: 16,
    lineHeight: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
});

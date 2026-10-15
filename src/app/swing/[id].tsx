import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import type { DrawTool } from '@/components/drawing-overlay';
import { Segmented } from '@/components/segmented';
import { ClubPicker, ResultChips } from '@/components/shot-tags';
import { ThemedText } from '@/components/themed-text';
import { VideoPane } from '@/components/video-pane';
import { Spacing } from '@/constants/theme';
import { SPEEDS, useLinkedPlayers } from '@/hooks/use-linked-players';
import { useTheme } from '@/hooks/use-theme';
import {
  angleLabels,
  angleLink,
  exportSource,
  formatSync,
  nudgeStepMs,
  type ReviewLayout,
} from '@/lib/multicam';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { formatClipTime, formatTempo, SOURCE_LABEL, type Angle, type Swing } from '@/lib/swing-library';
import type { Drawings, Shape, SwingNotes } from '@/lib/swing-notes';
import { deleteSwing, getSwing, setAngleNudge, updateSwingNotes } from '@/lib/swing-store';
import SwingCapture from '../../../modules/swing-capture';

type Panel = 'play' | 'tag' | 'draw' | 'share';

const PANELS = [
  { value: 'play', label: 'Play' },
  { value: 'tag', label: 'Tag' },
  { value: 'draw', label: 'Draw' },
  { value: 'share', label: 'Share' },
] as const;

const TOOLS: { value: DrawTool; label: string; hint: string }[] = [
  { value: 'plane', label: 'Plane', hint: 'Drag along the shaft at address: the line runs across the picture.' },
  { value: 'line', label: 'Line', hint: 'Drag to draw a line (spine, knee flex, alignment).' },
  { value: 'circle', label: 'Circle', hint: 'Drag from the centre of the head outwards.' },
  { value: 'angle', label: 'Angle', hint: 'Drag the first arm from the corner, then tap the end of the second.' },
];

export default function SwingReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [swing, setSwing] = useState(() => getSwing(id));

  // The second camera's clip lands a few seconds after the main one; pick it up if we're open.
  useEffect(() => {
    const sub = SwingCapture.addListener('onAngleReady', (e) => {
      if (e.id === id) setSwing(getSwing(id));
    });
    return () => sub.remove();
  }, [id]);

  if (!swing) {
    return (
      <SafeAreaView style={styles.missing}>
        <ThemedText>This swing no longer exists.</ThemedText>
      </SafeAreaView>
    );
  }
  // Fresh players when the angle arrives (a player's source is fixed when it's created).
  return <Review key={swing.angle?.uri ?? 'single'} swing={swing} />;
}

function Review({ swing }: { swing: Swing }) {
  const theme = useTheme();
  const [panel, setPanel] = useState<Panel>('play');
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [layout, setLayout] = useState<ReviewLayout>('both');
  const [nudgeMs, setNudgeMs] = useState(swing.angle?.nudgeMs ?? 0);
  const [notes, setNotes] = useState<SwingNotes>(swing.notes);
  const [showClubPicker, setShowClubPicker] = useState(false);
  const [tool, setTool] = useState<DrawTool | null>(null);
  /** Which clip each drawing went on, newest last, for undo. */
  const [history, setHistory] = useState<(keyof Drawings)[]>([]);
  const [grid, setGrid] = useState(false);
  const [mirrored, setMirrored] = useState(false);

  const angle: Angle | null = useMemo(() => (swing.angle ? { ...swing.angle, nudgeMs } : null), [swing.angle, nudgeMs]);
  const link = useMemo(() => (angle ? angleLink(swing, angle) : null), [angle, swing]);
  const { player, playerB, isPlaying, rate, pause, showAt, togglePlay, step, changeRate } = useLinkedPlayers(
    swing.uri,
    swing.angle?.uri ?? null,
    link
  );

  const [labelA, labelB] = angle ? angleLabels(angle) : ['', ''];
  const showA = !angle || layout !== 'b';
  const showB = !!angle && layout !== 'a';
  const drawing = panel === 'draw' ? tool : null;

  const saveNotes = (patch: Partial<SwingNotes>) => setNotes(updateSwingNotes(swing.id, patch));

  const addShape = (clip: keyof Drawings) => (shape: Shape) => {
    saveNotes({ drawings: { ...notes.drawings, [clip]: [...notes.drawings[clip], shape] } });
    setHistory((h) => [...h, clip]);
  };

  const undo = () => {
    // Undo this visit's drawings first, then older ones from the clip on screen.
    const clip = history[history.length - 1] ?? (showA && notes.drawings.a.length ? 'a' : 'b');
    if (notes.drawings[clip].length === 0) return;
    saveNotes({ drawings: { ...notes.drawings, [clip]: notes.drawings[clip].slice(0, -1) } });
    setHistory((h) => h.slice(0, -1));
  };

  const clearDrawings = () =>
    Alert.alert('Clear drawings?', 'Removes every line, circle and angle on this swing.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          saveNotes({ drawings: { a: [], b: [] } });
          setHistory([]);
        },
      },
    ]);

  const pickTool = (t: DrawTool) => {
    // Drawing is done on a still frame.
    pause();
    setTool((cur) => (cur === t ? null : t));
  };

  const goToImpact = () => {
    if (swing.impactOffsetMs != null) showAt(swing.impactOffsetMs / 1000);
  };

  /** Moves the second angle by one of its frames against the first, for clips that look off. */
  const nudge = (frames: number) => {
    if (!angle) return;
    const next = Math.round((nudgeMs + frames * nudgeStepMs(angle.fps)) * 100) / 100;
    setNudgeMs(next);
    setAngleNudge(swing.id, next);
    // Stay on this frame of the main clip; re-seek the angle with the new alignment.
    showAt(player.currentTime, angleLink(swing, { ...angle, nudgeMs: next }));
  };

  // Save / Share what's on screen: both angles side by side, or the one shown.
  const source = exportSource(swing, angle, layout);

  const run = async (kind: 'save' | 'share') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(source);
        setNotice(
          source.angle
            ? 'Saved to your gallery in slow motion, both angles side by side.'
            : 'Saved to your gallery in slow motion.'
        );
      } else {
        await shareSwing(source);
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete swing?', 'This removes the clip from your phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          pause();
          deleteSwing(swing.id);
          router.back();
        },
      },
    ]);

  const compare = () => {
    pause();
    router.push({ pathname: '/compare-pick', params: { a: swing.id } });
  };

  const title = [formatClipTime(swing.createdAt), swing.source && SOURCE_LABEL[swing.source]]
    .filter(Boolean)
    .join(' · ');
  const sync = formatSync(angle?.syncMs ?? null);
  const toolHint = TOOLS.find((t) => t.value === tool)?.hint;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title }} />
      <View style={styles.videos}>
        {showA && (
          <VideoPane
            player={player}
            label={showB ? labelA : undefined}
            mirrored={mirrored}
            grid={grid}
            shapes={notes.drawings.a}
            tool={drawing}
            onAddShape={addShape('a')}
          />
        )}
        {showB && (
          <VideoPane
            player={playerB}
            label={showA ? labelB : undefined}
            mirrored={mirrored}
            grid={grid}
            shapes={notes.drawings.b}
            tool={drawing}
            onAddShape={addShape('b')}
          />
        )}
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.controls, { backgroundColor: theme.background }]}>
        <Segmented
          options={PANELS}
          value={panel}
          onChange={(p) => {
            setPanel(p);
            if (p !== 'draw') setTool(null);
          }}
          accessibilityLabel="Review tools"
        />

        {panel === 'play' && (
          <>
            {swing.tempo && (
              <ThemedText type="smallBold" style={styles.centered}>
                {formatTempo(swing.tempo)}
              </ThemedText>
            )}
            {angle && (
              <View style={styles.row}>
                <Chip label="Both" selected={layout === 'both'} onPress={() => setLayout('both')} />
                <Chip label={labelA} selected={layout === 'a'} onPress={() => setLayout('a')} />
                <Chip label={labelB} selected={layout === 'b'} onPress={() => setLayout('b')} />
              </View>
            )}
            <View style={styles.row}>
              {SPEEDS.map((s) => (
                <Chip key={s.label} label={s.label} selected={rate === s.rate} onPress={() => changeRate(s.rate)} />
              ))}
            </View>
            <View style={styles.row}>
              <Chip label="◀ frame" onPress={() => step(-1, swing.fps)} />
              <Chip label={isPlaying ? 'Pause' : 'Play'} selected onPress={togglePlay} />
              <Chip label="frame ▶" onPress={() => step(1, swing.fps)} />
            </View>
            {angle && layout === 'both' && (
              <View style={styles.row}>
                <Chip label={`◀ ${labelB}`} onPress={() => nudge(-1)} />
                <ThemedText type="small" themeColor="textSecondary" style={styles.syncText}>
                  {nudgeMs === 0
                    ? `In sync${sync ? ` ${sync}` : ''}`
                    : `Adjusted ${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
                </ThemedText>
                <Chip label={`${labelB} ▶`} onPress={() => nudge(1)} />
              </View>
            )}
            {swing.impactOffsetMs != null && (
              <View style={styles.row}>
                <Chip label="Jump to impact" onPress={goToImpact} />
              </View>
            )}
          </>
        )}

        {panel === 'tag' && (
          <>
            <View style={styles.row}>
              <Chip
                label={notes.favorite ? '★ Favourite' : '☆ Favourite'}
                selected={notes.favorite}
                onPress={() => saveNotes({ favorite: !notes.favorite })}
              />
              <Chip label={notes.club ? `Club: ${notes.club}` : 'Club…'} onPress={() => setShowClubPicker(true)} />
            </View>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
              What did the ball do?
            </ThemedText>
            <ResultChips value={notes.result} onChange={(result) => saveNotes({ result })} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
              Favourites are never auto-deleted, and are quick to compare against.
            </ThemedText>
          </>
        )}

        {panel === 'draw' && (
          <>
            <View style={styles.row}>
              {TOOLS.map((t) => (
                <Chip key={t.value} label={t.label} selected={tool === t.value} onPress={() => pickTool(t.value)} />
              ))}
            </View>
            <View style={styles.row}>
              <Chip label="Undo" onPress={undo} />
              <Chip label="Clear" danger onPress={clearDrawings} />
              <Chip label="Grid" selected={grid} onPress={() => setGrid((g) => !g)} />
              <Chip label="Mirror" selected={mirrored} onPress={() => setMirrored((m) => !m)} />
              <Chip
                label="?"
                accessibilityLabel="What to look for"
                onPress={() => {
                  pause();
                  router.push({ pathname: '/help', params: { topic: 'reading' } });
                }}
              />
            </View>
            <View style={styles.row}>
              <Chip label="◀ frame" onPress={() => step(-1, swing.fps)} />
              <Chip label={isPlaying ? 'Pause' : 'Play'} selected onPress={togglePlay} />
              <Chip label="frame ▶" onPress={() => step(1, swing.fps)} />
            </View>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
              {toolHint ?? 'Pick a tool, then draw on the video. Drawings stay on as it plays.'}
            </ThemedText>
          </>
        )}

        {panel === 'share' && (
          <>
            <View style={styles.row}>
              <Chip label="Compare with…" onPress={compare} />
              <Chip label={busy === 'save' ? 'Saving…' : 'Save to Photos'} onPress={() => !busy && run('save')} />
              <Chip label={busy === 'share' ? 'Preparing…' : 'Share'} onPress={() => !busy && run('share')} />
              <Chip label="Delete" danger onPress={confirmDelete} />
            </View>
            <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
              {notice ??
                (angle && layout === 'both'
                  ? 'Saves and shares both angles side by side.'
                  : 'Saves and shares the clip on screen in slow motion.')}
            </ThemedText>
          </>
        )}
      </SafeAreaView>
      <ClubPicker
        visible={showClubPicker}
        value={notes.club}
        onChange={(club) => saveNotes({ club })}
        onClose={() => setShowClubPicker(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  videos: { flex: 1, flexDirection: 'row' },
  controls: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.two },
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  syncText: { minWidth: 110, textAlign: 'center' },
  centered: { textAlign: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

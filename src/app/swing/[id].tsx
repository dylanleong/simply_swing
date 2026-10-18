import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import type { DrawTool } from '@/components/drawing-overlay';
import type { IconName } from '@/components/icon';
import { IconButton } from '@/components/icon-button';
import { ModeBar } from '@/components/mode-bar';
import { leaveToLibrary, SwingNotFound } from '@/components/swing-not-found';
import { Sheet, SheetRow } from '@/components/sheet';
import { ClubPicker, ResultChips } from '@/components/shot-tags';
import { MaxFontScale, ThemedText } from '@/components/themed-text';
import { Transport } from '@/components/transport';
import { VideoPane } from '@/components/video-pane';
import { Spacing } from '@/constants/theme';
import { useLayout } from '@/hooks/use-layout';
import { useLinkedPlayers } from '@/hooks/use-linked-players';
import { useTheme } from '@/hooks/use-theme';
import { DOCK_COLUMN_WIDTH } from '@/lib/layout';
import { angleLabels, angleLink, exportSource, formatSync, nudgeStepMs, type ReviewLayout } from '@/lib/multicam';
import { PHOTOS, SAVE_TO_PHOTOS } from '@/lib/photos-name';
import { replayStartMs } from '@/lib/replay-start';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { clipAspect, formatClipTime, formatTempo, type Angle, type Swing } from '@/lib/swing-library';
import type { Drawings, Shape, SwingNotes } from '@/lib/swing-notes';
import { alertDeleteFailed, alertSaveFailed } from '@/lib/storage-alert';
import { deleteSwing, getSwing, setAngleNudge, updateSwingNotes } from '@/lib/swing-store';
import SwingCapture from '../../../modules/swing-capture';

type Mode = 'tag' | 'draw';

const MODES = [
  { value: 'tag', label: 'Tag', icon: 'ion:pricetag-outline' },
  { value: 'draw', label: 'Draw', icon: 'ion:pencil' },
] as const;

const TOOLS: { value: DrawTool; label: string; icon: IconName; hint: string }[] = [
  { value: 'plane', label: 'Plane', icon: 'mci:ray-start-end', hint: 'Drag along the shaft at address.' },
  { value: 'line', label: 'Line', icon: 'mci:vector-line', hint: 'Drag to draw a line.' },
  { value: 'circle', label: 'Circle', icon: 'mci:circle-outline', hint: 'Drag from the centre of the head.' },
  { value: 'angle', label: 'Angle', icon: 'mci:angle-acute', hint: 'Drag one arm from the corner, then tap the other end.' },
];

/** The tray between the transport and the mode bar never changes height, so nothing above it moves. */
const TRAY_HEIGHT = 152;
/** Text in the dock grows with the system font size up to this, which still fits TRAY_HEIGHT. */
const DOCK_MAX_FONT_SCALE = 1.3;
const NOTICE_MS = 3500;
const STAR = '#FFC83D';

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

  if (!swing) return <SwingNotFound />;
  // Fresh players when the angle arrives (a player's source is fixed when it's created).
  return <Review key={swing.angle?.uri ?? 'single'} swing={swing} />;
}

function Review({ swing }: { swing: Swing }) {
  const theme = useTheme();
  const { isLarge, isLandscape } = useLayout();
  /** A tablet on its side: the dock stands beside the video instead of under it (and still never moves). */
  const dockAside = isLarge && isLandscape;
  const [mode, setMode] = useState<Mode>('tag');
  const [notes, setNotes] = useState<SwingNotes>(swing.notes);
  const [tool, setTool] = useState<DrawTool | null>(null);
  /** Which clip each drawing went on, newest last, for undo. */
  const [history, setHistory] = useState<(keyof Drawings)[]>([]);
  const [layout, setLayout] = useState<ReviewLayout>('both');
  const [nudgeMs, setNudgeMs] = useState(swing.angle?.nudgeMs ?? 0);
  const [grid, setGrid] = useState(false);
  const [mirrored, setMirrored] = useState(false);
  const [sheet, setSheet] = useState<'menu' | 'align' | 'club' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A Save / Share export is running; a second tap would start another. */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const angle: Angle | null = useMemo(() => (swing.angle ? { ...swing.angle, nudgeMs } : null), [swing.angle, nudgeMs]);
  const link = useMemo(() => (angle ? angleLink(swing, angle) : null), [angle, swing]);
  const { player, playerB, isPlaying, rate, position, failed, failedB, pause, showAt, togglePlay, step, changeRate } =
    useLinkedPlayers(swing.uri, swing.angle?.uri ?? null, link, replayStartMs(swing) / 1000);

  const [labelA, labelB] = angle ? angleLabels(angle) : ['', ''];
  const showA = !angle || layout !== 'b';
  const showB = !!angle && layout !== 'a';
  const drawing = mode === 'draw' ? tool : null;
  const duration = (swing.durationMs ?? 0) / 1000 || player.duration || 0;
  const impact = swing.impactOffsetMs != null ? swing.impactOffsetMs / 1000 : null;

  const say = (message: string, sticky = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    if (!sticky) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const saveNotes = (patch: Partial<SwingNotes>) => {
    const next = updateSwingNotes(swing.id, patch);
    if (next) setNotes(next);
    else alertSaveFailed();
  };

  const addShape = (clip: keyof Drawings) => (shape: Shape) => {
    saveNotes({ drawings: { ...notes.drawings, [clip]: [...notes.drawings[clip], shape] } });
    setHistory((h) => [...h, clip]);
  };

  const undo = () => {
    // This visit's drawings first, then older ones from the clip on screen.
    const clip = history[history.length - 1] ?? (showA && notes.drawings.a.length ? 'a' : 'b');
    if (notes.drawings[clip].length === 0) return;
    saveNotes({ drawings: { ...notes.drawings, [clip]: notes.drawings[clip].slice(0, -1) } });
    setHistory((h) => h.slice(0, -1));
  };

  const drawingCount = notes.drawings.a.length + notes.drawings.b.length;
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

  const changeMode = (m: Mode) => {
    setMode(m);
    if (m === 'draw') pause();
    else setTool(null);
  };

  /** Tapping an angle's label shows it alone; tapping again shows both. */
  const toggleSolo = (clip: 'a' | 'b') => setLayout((l) => (l === 'both' ? clip : 'both'));

  /** Moves the second angle by one of its frames against the first (null resets), for clips that look off. */
  const nudge = (frames: number | null) => {
    if (!angle) return;
    const next = frames == null ? 0 : Math.round((nudgeMs + frames * nudgeStepMs(angle.fps)) * 100) / 100;
    setNudgeMs(next);
    if (!setAngleNudge(swing.id, next)) alertSaveFailed();
    // Stay on this frame of the main clip; re-seek the angle with the new alignment.
    showAt(player.currentTime, angleLink(swing, { ...angle, nudgeMs: next }));
  };

  // Save / Share what's on screen: both angles side by side, or the one shown.
  const source = exportSource(swing, angle, layout);

  const run = async (kind: 'save' | 'share') => {
    setSheet(null);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    pause();
    say(kind === 'save' ? `Saving to your ${PHOTOS}…` : 'Preparing…', true);
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(source);
        say(source.angle ? `Saved to your ${PHOTOS}: both angles, side by side.` : `Saved to your ${PHOTOS} in slow motion.`);
      } else {
        await shareSwing(source);
        setNotice(null);
      }
    } catch (e) {
      say((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    setSheet(null);
    Alert.alert('Delete swing?', 'This removes the clip from your phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          pause();
          if (!deleteSwing(swing.id)) {
            alertDeleteFailed(1);
            return;
          }
          leaveToLibrary();
        },
      },
    ]);
  };

  const go = (pathname: '/compare-pick' | '/help', params: Record<string, string>) => {
    setSheet(null);
    pause();
    router.push({ pathname, params });
  };

  // Just when: the header also holds the star and the menu, and the tray shows the tags.
  const title = formatClipTime(swing.createdAt);
  const sync = formatSync(angle?.syncMs ?? null);
  const toolHint = TOOLS.find((t) => t.value === tool)?.hint;

  return (
    <View style={[styles.container, dockAside && styles.containerRow]}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <View style={styles.headerButtons}>
              <IconButton
                icon={notes.favorite ? 'ion:star' : 'ion:star-outline'}
                tint={notes.favorite ? STAR : undefined}
                accessibilityLabel={notes.favorite ? 'Remove from favourites' : 'Add to favourites'}
                size={40}
                onPress={() => saveNotes({ favorite: !notes.favorite })}
              />
              <IconButton icon="ion:ellipsis-horizontal" accessibilityLabel="More" size={40} onPress={() => setSheet('menu')} />
            </View>
          ),
        }}
      />
      <View style={styles.videos}>
        {showA && (
          <VideoPane
            player={player}
            aspect={clipAspect(swing)}
            label={angle ? labelA : undefined}
            onLabelPress={angle ? () => toggleSolo('a') : undefined}
            solo={layout === 'a'}
            mirrored={mirrored}
            grid={grid}
            shapes={notes.drawings.a}
            tool={drawing}
            onAddShape={addShape('a')}
            failed={failed}
            failedAction={{ label: 'Delete swing', onPress: confirmDelete }}
          />
        )}
        {showB && (
          <VideoPane
            player={playerB}
            aspect={clipAspect(swing.angle)}
            label={labelB}
            onLabelPress={() => toggleSolo('b')}
            solo={layout === 'b'}
            mirrored={mirrored}
            grid={grid}
            shapes={notes.drawings.b}
            tool={drawing}
            onAddShape={addShape('b')}
            failed={failedB}
          />
        )}
        {notice && (
          <View style={styles.notice} pointerEvents="none">
            <ThemedText style={styles.noticeText}>{notice}</ThemedText>
          </View>
        )}
      </View>

      <MaxFontScale.Provider value={DOCK_MAX_FONT_SCALE}>
        <SafeAreaView
          edges={dockAside ? ['bottom', 'right'] : ['bottom']}
          style={[styles.dock, dockAside && styles.dockAside, { backgroundColor: theme.background }]}>
          <View style={styles.padded}>
            <Transport
              duration={duration}
              position={position}
              impact={impact}
              isPlaying={isPlaying}
              rate={rate}
              onSeek={(t) => showAt(t)}
              onTogglePlay={togglePlay}
              onStep={(frames) => step(frames, swing.fps)}
              onRate={changeRate}
              onPause={pause}
            />
          </View>

          <View style={[styles.tray, styles.padded]}>
            {mode === 'tag' ? (
              <>
                <ResultChips value={notes.result} onChange={(result) => saveNotes({ result })} />
                <View style={styles.trayFooter}>
                  <Chip
                    size="sm"
                    icon="mci:golf"
                    label={notes.club ?? 'Club'}
                    accessibilityLabel={notes.club ? `Club ${notes.club}. Change` : 'Choose club'}
                    onPress={() => setSheet('club')}
                  />
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.flex}>
                    {swing.tempo ? formatTempo(swing.tempo) : ''}
                  </ThemedText>
                </View>
              </>
            ) : (
              <>
                <View style={styles.row}>
                  {TOOLS.map((t) => (
                    <Chip
                      key={t.value}
                      variant="option"
                      fill
                      icon={t.icon}
                      label={t.label}
                      selected={tool === t.value}
                      onPress={() => pickTool(t.value)}
                    />
                  ))}
                </View>
                <View style={styles.row}>
                  <Chip size="sm" icon="ion:arrow-undo-outline" label="Undo" onPress={undo} />
                  {drawingCount > 0 && <Chip size="sm" variant="danger" label="Clear all" onPress={clearDrawings} />}
                  <View style={styles.flex} />
                  <IconButton
                    icon="ion:help-circle-outline"
                    accessibilityLabel="What to look for"
                    size={36}
                    onPress={() => go('/help', { topic: 'reading' })}
                  />
                </View>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {toolHint ?? 'Pick a tool, then draw on the video.'}
                </ThemedText>
              </>
            )}
          </View>

          <ModeBar modes={MODES} value={mode} onChange={changeMode} />
        </SafeAreaView>
      </MaxFontScale.Provider>

      <Sheet visible={sheet === 'menu'} onClose={() => setSheet(null)}>
        <SheetRow
          icon="ion:download-outline"
          label={SAVE_TO_PHOTOS}
          detail={busy ? 'Working…' : source.angle ? 'Side by side' : undefined}
          disabled={busy || failed}
          onPress={() => run('save')}
        />
        <SheetRow icon="ion:share-outline" label="Share" disabled={busy || failed} onPress={() => run('share')} />
        <SheetRow
          icon="ion:git-compare-outline"
          label="Compare with another swing"
          disabled={busy || failed}
          onPress={() => go('/compare-pick', { a: swing.id })}
        />
        {angle && (
          <SheetRow
            icon="ion:swap-horizontal-outline"
            label="Line up the angles"
            detail={nudgeMs === 0 ? (sync ?? undefined) : `${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
            onPress={() => setSheet('align')}
          />
        )}
        <SheetRow icon="mci:grid" label="Grid" checked={grid} onPress={() => setGrid((g) => !g)} />
        <SheetRow icon="mci:flip-horizontal" label="Mirror" checked={mirrored} onPress={() => setMirrored((m) => !m)} />
        <SheetRow icon="ion:help-circle-outline" label="What to look for" onPress={() => go('/help', { topic: 'reading' })} />
        <SheetRow icon="ion:trash-outline" label="Delete swing" danger onPress={confirmDelete} />
      </Sheet>

      <Sheet visible={sheet === 'align'} onClose={() => setSheet(null)} title="Line up the angles">
        <View style={styles.sheetBody}>
          <ThemedText type="small" themeColor="textSecondary">
            Step to a clear moment (impact is best). If the {labelB} view is a frame early or late, move it here.
          </ThemedText>
          <View style={styles.row}>
            <Chip icon="ion:caret-back" label="Earlier" fill onPress={() => nudge(-1)} />
            <ThemedText style={styles.syncText}>
              {nudgeMs === 0 ? `In sync${sync ? ` ${sync}` : ''}` : `${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
            </ThemedText>
            <Chip icon="ion:caret-forward" label="Later" fill onPress={() => nudge(1)} />
          </View>
          {nudgeMs !== 0 && <Chip variant="option" label="Reset" onPress={() => nudge(null)} />}
        </View>
      </Sheet>

      <ClubPicker
        visible={sheet === 'club'}
        value={notes.club}
        onChange={(club) => saveNotes({ club })}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  containerRow: { flexDirection: 'row' },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  videos: { flex: 1, flexDirection: 'row' },
  notice: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: Spacing.three,
    alignItems: 'center',
  },
  noticeText: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    textAlign: 'center',
  },
  dock: { paddingTop: Spacing.two },
  dockAside: { width: DOCK_COLUMN_WIDTH, justifyContent: 'flex-end' },
  padded: { paddingHorizontal: Spacing.three },
  tray: { height: TRAY_HEIGHT, gap: Spacing.two, justifyContent: 'center' },
  trayFooter: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  flex: { flex: 1 },
  sheetBody: { paddingHorizontal: Spacing.four, gap: Spacing.three, paddingBottom: Spacing.two },
  syncText: { minWidth: 96, textAlign: 'center', fontWeight: '600' },
});

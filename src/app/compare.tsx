import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { IconButton } from '@/components/icon-button';
import { Sheet, SheetRow } from '@/components/sheet';
import { SwingNotFound } from '@/components/swing-not-found';
import { MaxFontScale, ThemedText } from '@/components/themed-text';
import { Transport } from '@/components/transport';
import { VideoPane } from '@/components/video-pane';
import { Spacing } from '@/constants/theme';
import { useLayout } from '@/hooks/use-layout';
import { useLinkedPlayers } from '@/hooks/use-linked-players';
import { useTheme } from '@/hooks/use-theme';
import { DOCK_COLUMN_WIDTH } from '@/lib/layout';
import { compareLink, nudgeStepMs, swingAnchorMs } from '@/lib/multicam';
import { PHOTOS, SAVE_TO_PHOTOS } from '@/lib/photos-name';
import { replayStartMs } from '@/lib/replay-start';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { clipAspect, formatClipTime, type Swing } from '@/lib/swing-library';
import { notesSummary } from '@/lib/swing-notes';
import { getSwing } from '@/lib/swing-store';

const NOTICE_MS = 3500;
/** As in review: the dock's text grows with the system font size, but only this far. */
const DOCK_MAX_FONT_SCALE = 1.3;

export default function CompareScreen() {
  const { a, b } = useLocalSearchParams<{ a: string; b: string }>();
  const [swings] = useState(() => [getSwing(a), getSwing(b)] as const);
  const [swingA, swingB] = swings;
  if (!swingA || !swingB) return <SwingNotFound message="One of these swings isn’t on this phone any more." />;
  return <Compare a={swingA} b={swingB} />;
}

const paneLabel = (s: Swing) => [formatClipTime(s.createdAt), notesSummary(s.notes)].filter(Boolean).join(' · ');

/** Two swings side by side, lined up on impact (or the trigger, for button saves). */
function Compare({ a, b }: { a: Swing; b: Swing }) {
  const theme = useTheme();
  const { isLarge, isLandscape } = useLayout();
  /** As in review: on a tablet on its side the dock stands beside the videos. */
  const dockAside = isLarge && isLandscape;
  const [nudgeMs, setNudgeMs] = useState(0);
  const [grid, setGrid] = useState(false);
  const [mirrored, setMirrored] = useState(false);
  const [sheet, setSheet] = useState<'menu' | 'align' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A Save / Share export is running; a second tap would start another. */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const link = useMemo(() => compareLink(a, b, nudgeMs), [a, b, nudgeMs]);
  const { player, playerB, isPlaying, rate, position, failed, failedB, pause, showAt, togglePlay, step, changeRate } =
    useLinkedPlayers(a.uri, b.uri, link, replayStartMs(a) / 1000);
  const duration = (a.durationMs ?? 0) / 1000 || player.duration || 0;

  const say = (message: string, sticky = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    if (!sticky) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const nudge = (frames: number | null) => {
    const next = frames == null ? 0 : Math.round((nudgeMs + frames * nudgeStepMs(b.fps)) * 100) / 100;
    setNudgeMs(next);
    showAt(player.currentTime, compareLink(a, b, next));
  };

  const run = async (kind: 'save' | 'share') => {
    setSheet(null);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    pause();
    say(kind === 'save' ? `Saving to your ${PHOTOS}…` : 'Preparing…', true);
    const source = { uri: a.uri, angle: { uri: b.uri, shiftMs: link.shiftSec * 1000 } };
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(source);
        say(`Saved to your ${PHOTOS}, side by side.`);
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

  const lined = a.impactOffsetMs != null && b.impactOffsetMs != null ? 'impact' : 'the save';
  const nudgeLabel = `${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`;

  return (
    <View style={[styles.container, dockAside && styles.containerRow]}>
      <Stack.Screen
        options={{
          title: 'Compare',
          headerRight: () => (
            <IconButton icon="ion:ellipsis-horizontal" accessibilityLabel="More" size={40} onPress={() => setSheet('menu')} />
          ),
        }}
      />
      <View style={styles.videos}>
        <VideoPane
          player={player}
          aspect={clipAspect(a)}
          label={paneLabel(a)}
          mirrored={mirrored}
          grid={grid}
          shapes={a.notes.drawings.a}
          failed={failed}
        />
        <VideoPane
          player={playerB}
          aspect={clipAspect(b)}
          label={paneLabel(b)}
          mirrored={mirrored}
          grid={grid}
          shapes={b.notes.drawings.a}
          failed={failedB}
        />
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
          <Transport
            duration={duration}
            position={position}
            impact={swingAnchorMs(a) / 1000}
            isPlaying={isPlaying}
            rate={rate}
            onSeek={(t) => showAt(t)}
            onTogglePlay={togglePlay}
            onStep={(frames) => step(frames, a.fps)}
            onRate={changeRate}
            onPause={pause}
          />
          {/* Lining up lives in the ⋯ sheet, like review; this line just says where things stand. */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.syncText} numberOfLines={1}>
            {nudgeMs === 0 ? `Lined up on ${lined}` : `Right swing ${nudgeLabel}`}
          </ThemedText>
        </SafeAreaView>
      </MaxFontScale.Provider>

      <Sheet visible={sheet === 'menu'} onClose={() => setSheet(null)}>
        <SheetRow
          icon="ion:download-outline"
          label={SAVE_TO_PHOTOS}
          detail={busy ? 'Working…' : 'Side by side'}
          disabled={busy || failed || failedB}
          onPress={() => run('save')}
        />
        <SheetRow icon="ion:share-outline" label="Share" disabled={busy || failed || failedB} onPress={() => run('share')} />
        <SheetRow
          icon="ion:swap-horizontal-outline"
          label="Line up the swings"
          detail={nudgeMs === 0 ? undefined : nudgeLabel}
          onPress={() => setSheet('align')}
        />
        <SheetRow icon="mci:grid" label="Grid" checked={grid} onPress={() => setGrid((g) => !g)} />
        <SheetRow icon="mci:flip-horizontal" label="Mirror" checked={mirrored} onPress={() => setMirrored((m) => !m)} />
      </Sheet>

      <Sheet visible={sheet === 'align'} onClose={() => setSheet(null)} title="Line up the swings">
        <View style={styles.sheetBody}>
          <ThemedText type="small" themeColor="textSecondary">
            Step to a clear moment (impact is best). If the right swing is a frame early or late, move it here.
          </ThemedText>
          <View style={styles.row}>
            <Chip icon="ion:caret-back" label="Earlier" fill onPress={() => nudge(-1)} accessibilityLabel="Move the right swing earlier" />
            <ThemedText style={styles.nudgeText}>{nudgeMs === 0 ? `On ${lined}` : nudgeLabel}</ThemedText>
            <Chip icon="ion:caret-forward" label="Later" fill onPress={() => nudge(1)} accessibilityLabel="Move the right swing later" />
          </View>
          {nudgeMs !== 0 && <Chip variant="option" label="Line up on impact again" onPress={() => nudge(null)} />}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  containerRow: { flexDirection: 'row' },
  videos: { flex: 1, flexDirection: 'row' },
  notice: { position: 'absolute', left: Spacing.three, right: Spacing.three, bottom: Spacing.three, alignItems: 'center' },
  noticeText: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    textAlign: 'center',
  },
  dock: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, paddingBottom: Spacing.two, gap: Spacing.two },
  dockAside: { width: DOCK_COLUMN_WIDTH, justifyContent: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  syncText: { textAlign: 'center' },
  sheetBody: { paddingHorizontal: Spacing.four, gap: Spacing.three, paddingBottom: Spacing.two },
  nudgeText: { minWidth: 96, textAlign: 'center', fontWeight: '600' },
});

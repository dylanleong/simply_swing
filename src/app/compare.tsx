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
import { useLinkedPlayers } from '@/hooks/use-linked-players';
import { useTheme } from '@/hooks/use-theme';
import { compareLink, nudgeStepMs, swingAnchorMs } from '@/lib/multicam';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { formatClipTime, type Swing } from '@/lib/swing-library';
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
  const [nudgeMs, setNudgeMs] = useState(0);
  const [grid, setGrid] = useState(false);
  const [mirrored, setMirrored] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A Save / Share export is running; a second tap would start another. */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const link = useMemo(() => compareLink(a, b, nudgeMs), [a, b, nudgeMs]);
  const { player, playerB, isPlaying, rate, position, failed, failedB, pause, showAt, togglePlay, step, changeRate } =
    useLinkedPlayers(
    a.uri,
    b.uri,
    link
  );
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
    setMenu(false);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    pause();
    say(kind === 'save' ? 'Saving to your gallery…' : 'Preparing…', true);
    const source = { uri: a.uri, angle: { uri: b.uri, shiftMs: link.shiftSec * 1000 } };
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(source);
        say('Saved to your gallery, side by side.');
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

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Compare',
          headerRight: () => (
            <IconButton icon="ion:ellipsis-horizontal" accessibilityLabel="More" size={40} onPress={() => setMenu(true)} />
          ),
        }}
      />
      <View style={styles.videos}>
        <VideoPane
          player={player}
          label={paneLabel(a)}
          mirrored={mirrored}
          grid={grid}
          shapes={a.notes.drawings.a}
          failed={failed}
        />
        <VideoPane
          player={playerB}
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
        <SafeAreaView edges={['bottom']} style={[styles.dock, { backgroundColor: theme.background }]}>
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
          <View style={styles.row}>
            <Chip size="sm" icon="ion:caret-back" label="Earlier" onPress={() => nudge(-1)} accessibilityLabel="Move the right swing earlier" />
            <ThemedText type="small" themeColor="textSecondary" style={styles.syncText} numberOfLines={1}>
              {nudgeMs === 0 ? `Lined up on ${lined}` : `Right swing ${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
            </ThemedText>
            <Chip size="sm" icon="ion:caret-forward" label="Later" onPress={() => nudge(1)} accessibilityLabel="Move the right swing later" />
          </View>
        </SafeAreaView>
      </MaxFontScale.Provider>

      <Sheet visible={menu} onClose={() => setMenu(false)}>
        <SheetRow
          icon="ion:download-outline"
          label="Save to Photos"
          detail={busy ? 'Working…' : 'Side by side'}
          disabled={busy || failed || failedB}
          onPress={() => run('save')}
        />
        <SheetRow icon="ion:share-outline" label="Share" disabled={busy || failed || failedB} onPress={() => run('share')} />
        {nudgeMs !== 0 && <SheetRow icon="ion:refresh-outline" label="Line up on impact again" onPress={() => { setMenu(false); nudge(null); }} />}
        <SheetRow icon="mci:grid" label="Grid" checked={grid} onPress={() => setGrid((g) => !g)} />
        <SheetRow icon="mci:flip-horizontal" label="Mirror" checked={mirrored} onPress={() => setMirrored((m) => !m)} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  syncText: { flex: 1, textAlign: 'center' },
});

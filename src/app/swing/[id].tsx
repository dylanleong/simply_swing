import { useEvent } from 'expo';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { angleLabels, angleTimeSec, driftCorrectionSec, formatSync, nudgeStepMs } from '@/lib/multicam';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { formatClipTime, SOURCE_LABEL, type Angle, type Swing } from '@/lib/swing-library';
import { deleteSwing, getSwing, setAngleNudge } from '@/lib/swing-store';
import SwingCapture from '../../../modules/swing-capture';

const SPEEDS = [
  { rate: 1, label: '1×' },
  { rate: 0.5, label: '½' },
  { rate: 0.25, label: '¼' },
  { rate: 0.125, label: '⅛' },
] as const;

const DEFAULT_RATE = 0.25;
/** How often the second angle is checked against the first while playing. */
const SYNC_TICK_MS = 200;

type Layout = 'both' | 'a' | 'b';

/** The players are mutable native objects; React Compiler only objects to mutating them inline. */
function setPlaybackRate(player: VideoPlayer, rate: number) {
  player.playbackRate = rate;
}

/** Exact seek (expo-video's `currentTime` is frame accurate; `seekBy` may snap to keyframes). */
function seekTo(player: VideoPlayer, seconds: number) {
  player.currentTime = Math.max(0, seconds);
}

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
  const [rate, setRate] = useState<number>(DEFAULT_RATE);
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>('both');
  const [nudgeMs, setNudgeMs] = useState(swing.angle?.nudgeMs ?? 0);
  const angle: Angle | null = useMemo(() => (swing.angle ? { ...swing.angle, nudgeMs } : null), [swing.angle, nudgeMs]);

  const setup = (p: VideoPlayer) => {
    p.loop = true;
    p.muted = true;
    p.playbackRate = DEFAULT_RATE;
    p.play();
  };
  const player = useVideoPlayer(swing.uri, setup);
  const playerB = useVideoPlayer(swing.angle?.uri ?? null, setup);
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  // Two native players drift apart while playing (and loop at slightly different moments); keep the
  // second angle within a frame of where the first says it should be.
  useEffect(() => {
    if (!angle || !isPlaying) return;
    const timer = setInterval(() => {
      const fix = driftCorrectionSec(player.currentTime, playerB.currentTime, swing, angle);
      if (fix !== 0) seekTo(playerB, playerB.currentTime + fix);
      if (!playerB.playing) playerB.play();
    }, SYNC_TICK_MS);
    return () => clearInterval(timer);
  }, [angle, isPlaying, player, playerB, swing]);

  const frameSec = 1 / (swing.fps ?? 120);
  const [labelA, labelB] = angle ? angleLabels(angle) : ['', ''];
  const showA = !angle || layout !== 'b';
  const showB = !!angle && layout !== 'a';

  /** Pauses both and shows the first angle at [t] (and the second at the matching moment). */
  const showAt = (t: number) => {
    player.pause();
    playerB.pause();
    seekTo(player, t);
    if (angle) seekTo(playerB, angleTimeSec(t, swing, angle));
  };

  const changeRate = (r: number) => {
    setRate(r);
    setPlaybackRate(player, r);
    setPlaybackRate(playerB, r);
  };

  const togglePlay = () => {
    if (isPlaying) {
      player.pause();
      playerB.pause();
      return;
    }
    if (angle) seekTo(playerB, angleTimeSec(player.currentTime, swing, angle));
    player.play();
    if (angle) playerB.play();
  };

  const step = (frames: number) => showAt(player.currentTime + frames * frameSec);

  const goToImpact = () => {
    if (swing.impactOffsetMs != null) showAt(swing.impactOffsetMs / 1000);
  };

  /** Moves the second angle by one of its frames against the first, for clips that look off. */
  const nudge = (frames: number) => {
    if (!angle) return;
    const next = Math.round((nudgeMs + frames * nudgeStepMs(angle.fps)) * 100) / 100;
    setNudgeMs(next);
    setAngleNudge(swing.id, next);
    const t = player.currentTime;
    player.pause();
    playerB.pause();
    seekTo(playerB, angleTimeSec(t, swing, { ...angle, nudgeMs: next }));
  };

  // Save / Share the angle on screen (the first when both are).
  const exportUri = layout === 'b' && angle ? angle.uri : swing.uri;

  const run = async (kind: 'save' | 'share') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(exportUri);
        setNotice('Saved to your gallery in slow motion.');
      } else {
        await shareSwing(exportUri);
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
          player.pause();
          playerB.pause();
          deleteSwing(swing.id);
          router.back();
        },
      },
    ]);

  const title = [formatClipTime(swing.createdAt), swing.source && SOURCE_LABEL[swing.source]]
    .filter(Boolean)
    .join(' · ');
  const sync = formatSync(angle?.syncMs ?? null);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title }} />
      <View style={styles.videos}>
        {showA && (
          <View style={styles.video}>
            <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
            {showB && <ThemedText style={styles.videoLabel}>{labelA}</ThemedText>}
          </View>
        )}
        {showB && (
          <View style={styles.video}>
            <VideoView player={playerB} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
            {showA && <ThemedText style={styles.videoLabel}>{labelB}</ThemedText>}
          </View>
        )}
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.controls, { backgroundColor: theme.background }]}>
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
          <Chip label="◀ frame" onPress={() => step(-1)} />
          <Chip label={isPlaying ? 'Pause' : 'Play'} selected onPress={togglePlay} />
          <Chip label="frame ▶" onPress={() => step(1)} />
        </View>
        {angle && layout === 'both' && (
          <View style={styles.row}>
            <Chip label={`◀ ${labelB}`} onPress={() => nudge(-1)} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.syncText}>
              {nudgeMs === 0 ? `In sync${sync ? ` ${sync}` : ''}` : `Adjusted ${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
            </ThemedText>
            <Chip label={`${labelB} ▶`} onPress={() => nudge(1)} />
          </View>
        )}
        <View style={styles.row}>
          {swing.impactOffsetMs != null && <Chip label="Jump to impact" onPress={goToImpact} />}
          <Chip label={busy === 'save' ? 'Saving…' : 'Save to Photos'} onPress={() => !busy && run('save')} />
          <Chip label={busy === 'share' ? 'Preparing…' : 'Share'} onPress={() => !busy && run('share')} />
          <Chip label="Delete" danger onPress={confirmDelete} />
        </View>
        {notice && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
            {notice}
          </ThemedText>
        )}
      </SafeAreaView>
    </View>
  );
}

function Chip({
  label,
  onPress,
  selected = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  danger?: boolean;
}) {
  const theme = useTheme();
  const background = selected ? theme.accent : theme.backgroundElement;
  const color = selected ? '#fff' : danger ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: background, opacity: pressed ? 0.7 : 1 }]}>
      <ThemedText style={{ color }}>{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  videos: { flex: 1, flexDirection: 'row' },
  video: { flex: 1 },
  videoLabel: {
    position: 'absolute',
    top: Spacing.two,
    left: Spacing.two,
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
  controls: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.two },
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  chip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: Spacing.four },
  syncText: { minWidth: 110, textAlign: 'center' },
  notice: { textAlign: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

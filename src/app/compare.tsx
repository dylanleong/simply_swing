import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { ThemedText } from '@/components/themed-text';
import { VideoPane } from '@/components/video-pane';
import { Spacing } from '@/constants/theme';
import { SPEEDS, useLinkedPlayers } from '@/hooks/use-linked-players';
import { useTheme } from '@/hooks/use-theme';
import { compareLink, nudgeStepMs, swingAnchorMs } from '@/lib/multicam';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { formatClipTime, type Swing } from '@/lib/swing-library';
import { notesSummary } from '@/lib/swing-notes';
import { getSwing } from '@/lib/swing-store';

export default function CompareScreen() {
  const { a, b } = useLocalSearchParams<{ a: string; b: string }>();
  const [swings] = useState(() => [getSwing(a), getSwing(b)] as const);
  const [swingA, swingB] = swings;
  if (!swingA || !swingB) {
    return (
      <SafeAreaView style={styles.missing}>
        <ThemedText>One of these swings no longer exists.</ThemedText>
      </SafeAreaView>
    );
  }
  return <Compare a={swingA} b={swingB} />;
}

const paneLabel = (s: Swing) => [formatClipTime(s.createdAt), notesSummary(s.notes)].filter(Boolean).join(' · ');

/** Two swings side by side, lined up on impact (or the trigger, for button saves). */
function Compare({ a, b }: { a: Swing; b: Swing }) {
  const theme = useTheme();
  const [nudgeMs, setNudgeMs] = useState(0);
  const [grid, setGrid] = useState(false);
  const [mirrored, setMirrored] = useState(false);
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const link = useMemo(() => compareLink(a, b, nudgeMs), [a, b, nudgeMs]);
  const { player, playerB, isPlaying, rate, showAt, togglePlay, step, changeRate } = useLinkedPlayers(a.uri, b.uri, link);

  const nudge = (frames: number) => {
    const next = Math.round((nudgeMs + frames * nudgeStepMs(b.fps)) * 100) / 100;
    setNudgeMs(next);
    showAt(player.currentTime, compareLink(a, b, next));
  };

  const run = async (kind: 'save' | 'share') => {
    setBusy(kind);
    setNotice(null);
    const source = { uri: a.uri, angle: { uri: b.uri, shiftMs: link.shiftSec * 1000 } };
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(source);
        setNotice('Saved to your gallery in slow motion, side by side.');
      } else {
        await shareSwing(source);
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const lined = a.impactOffsetMs != null && b.impactOffsetMs != null ? 'impact' : 'the save';

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Compare' }} />
      <View style={styles.videos}>
        <VideoPane player={player} label={paneLabel(a)} mirrored={mirrored} grid={grid} shapes={a.notes.drawings.a} />
        <VideoPane player={playerB} label={paneLabel(b)} mirrored={mirrored} grid={grid} shapes={b.notes.drawings.a} />
      </View>
      <SafeAreaView edges={['bottom']} style={[styles.controls, { backgroundColor: theme.background }]}>
        <View style={styles.row}>
          {SPEEDS.map((s) => (
            <Chip key={s.label} label={s.label} selected={rate === s.rate} onPress={() => changeRate(s.rate)} />
          ))}
        </View>
        <View style={styles.row}>
          <Chip label="◀ frame" onPress={() => step(-1, a.fps)} />
          <Chip label={isPlaying ? 'Pause' : 'Play'} selected onPress={togglePlay} />
          <Chip label="frame ▶" onPress={() => step(1, a.fps)} />
        </View>
        <View style={styles.row}>
          <Chip label="◀ right" onPress={() => nudge(-1)} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.syncText}>
            {nudgeMs === 0 ? `Lined up on ${lined}` : `Right ${nudgeMs > 0 ? '+' : ''}${nudgeMs.toFixed(1)} ms`}
          </ThemedText>
          <Chip label="right ▶" onPress={() => nudge(1)} />
        </View>
        <View style={styles.row}>
          <Chip label="Jump to impact" onPress={() => showAt(swingAnchorMs(a) / 1000)} />
          <Chip label="Grid" selected={grid} onPress={() => setGrid((g) => !g)} />
          <Chip label="Mirror" selected={mirrored} onPress={() => setMirrored((m) => !m)} />
        </View>
        <View style={styles.row}>
          <Chip label={busy === 'save' ? 'Saving…' : 'Save to Photos'} onPress={() => !busy && run('save')} />
          <Chip label={busy === 'share' ? 'Preparing…' : 'Share'} onPress={() => !busy && run('share')} />
        </View>
        {notice && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
            {notice}
          </ThemedText>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  videos: { flex: 1, flexDirection: 'row' },
  controls: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.two },
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  syncText: { minWidth: 130, textAlign: 'center' },
  centered: { textAlign: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

import { useEvent } from 'expo';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { saveSwingToPhotos, shareSwing } from '@/lib/swing-export';
import { formatClipTime, SOURCE_LABEL } from '@/lib/swing-library';
import { deleteSwing, getSwing } from '@/lib/swing-store';

const SPEEDS = [
  { rate: 1, label: '1×' },
  { rate: 0.5, label: '½' },
  { rate: 0.25, label: '¼' },
  { rate: 0.125, label: '⅛' },
] as const;

const DEFAULT_RATE = 0.25;

/** The player is a mutable native object; React Compiler only objects to mutating it inline. */
function setPlaybackRate(player: VideoPlayer, rate: number) {
  player.playbackRate = rate;
}

export default function SwingReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const swing = useMemo(() => getSwing(id), [id]);
  const theme = useTheme();
  const [rate, setRate] = useState<number>(DEFAULT_RATE);
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const player = useVideoPlayer(swing?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
    p.playbackRate = DEFAULT_RATE;
    p.play();
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  if (!swing) {
    return (
      <SafeAreaView style={styles.missing}>
        <ThemedText>This swing no longer exists.</ThemedText>
      </SafeAreaView>
    );
  }

  const frameSec = 1 / (swing.fps ?? 120);

  const changeRate = (r: number) => {
    setRate(r);
    setPlaybackRate(player, r);
  };

  const step = (frames: number) => {
    player.pause();
    player.seekBy(frames * frameSec);
  };

  const goToImpact = () => {
    if (swing.impactOffsetMs == null) return;
    player.pause();
    player.seekBy(swing.impactOffsetMs / 1000 - player.currentTime);
  };

  const run = async (kind: 'save' | 'share') => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'save') {
        await saveSwingToPhotos(swing.uri);
        setNotice('Saved to your gallery in slow motion.');
      } else {
        await shareSwing(swing.uri);
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
          deleteSwing(swing.id);
          router.back();
        },
      },
    ]);

  const title = [formatClipTime(swing.createdAt), swing.source && SOURCE_LABEL[swing.source]]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title }} />
      <VideoView player={player} style={styles.video} contentFit="contain" nativeControls={false} />
      <SafeAreaView edges={['bottom']} style={[styles.controls, { backgroundColor: theme.background }]}>
        <View style={styles.row}>
          {SPEEDS.map((s) => (
            <Chip key={s.label} label={s.label} selected={rate === s.rate} onPress={() => changeRate(s.rate)} />
          ))}
        </View>
        <View style={styles.row}>
          <Chip label="◀ frame" onPress={() => step(-1)} />
          <Chip label={isPlaying ? 'Pause' : 'Play'} selected onPress={() => (isPlaying ? player.pause() : player.play())} />
          <Chip label="frame ▶" onPress={() => step(1)} />
        </View>
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
  video: { flex: 1 },
  controls: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.two },
  row: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  chip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: Spacing.four },
  notice: { textAlign: 'center' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

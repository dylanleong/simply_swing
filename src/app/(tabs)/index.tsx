import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { AppState, Pressable, StyleSheet, View, type LayoutRectangle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CaptureHelp } from '@/components/capture-help';
import { GolferBox, type PreviewFrame } from '@/components/golfer-box';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  clampRoi,
  FULL_BOUNDS,
  POST_ROLL_SEC,
  SENSITIVITY_VALUE,
  type CaptureSettings,
  type RoiBounds,
} from '@/lib/capture-settings';
import { loadCaptureSettings, saveCaptureSettings } from '@/lib/capture-settings-store';
import { idlePhase, shouldDim, type IdlePhase } from '@/lib/idle';
import { dimScreen, restoreScreen } from '@/lib/screen-dimmer';
import { listSwings, pruneOldSwings } from '@/lib/swing-store';
import SwingCapture, {
  SwingCaptureView,
  useCapturePermissions,
  type ActiveFormat,
  type CaptureConfig,
  type ClipReadyEvent,
  type EngineState,
  type ExposureEvent,
  type MotionEvent,
  type NormalizedRect,
  type SoundEvent,
} from '../../../modules/swing-capture';

function captureConfig(s: CaptureSettings): CaptureConfig {
  return {
    fps: s.fps,
    preRollSec: s.preRollSec,
    postRollSec: POST_ROLL_SEC,
    lookbackSec: s.lookbackSec,
    roi: s.roi,
    sensitivity: SENSITIVITY_VALUE[s.sensitivity],
    sharpMode: s.sharpMode,
    autoTrigger: true,
    impactTrigger: s.soundTrigger,
  };
}

const latestSwing = () => {
  const latest = listSwings()[0];
  return latest ? { id: latest.id, thumbUri: latest.thumbUri } : null;
};

/** 0.0008 s → "1/1250 s". */
const formatShutter = (sec: number) => (sec >= 1 ? `${sec.toFixed(1)} s` : `1/${Math.round(1 / sec)} s`);

const REPLAY_RATE = 0.25;
/** The replay covers the live camera; hand the screen back after a few loops. */
const REPLAY_AUTO_CLOSE_MS = 20_000;
/** The hint covers the top of the frame; once recording, get out of the way. */
const HINT_VISIBLE_MS = 6_000;

const SOUND_OUTCOME: Record<NonNullable<SoundEvent['reason']> | 'saved', string> = {
  saved: 'saved',
  quiet: 'too quiet',
  off: 'Auto off',
  touch: 'ignored, phone touched',
  still: 'ignored, no swing in box',
  busy: 'ignored, busy',
};

function describeSound(e: SoundEvent) {
  const outcome = SOUND_OUTCOME[e.accepted ? 'saved' : (e.reason ?? 'busy')];
  const swing =
    e.motionPeak != null && e.motionThreshold != null
      ? `, swing ${e.motionPeak.toFixed(1)}/${e.motionThreshold.toFixed(1)}`
      : '';
  return `Last sound ${Math.round(e.levelDb)} dB (needs ${Math.round(e.minLevelDb)})${swing} · ${outcome}`;
}

/** The camera image inside the preview view: the native side letterboxes ("contain") it. */
function previewFrame(view: LayoutRectangle, format: ActiveFormat | null | undefined): PreviewFrame {
  // Stream sizes are landscape (sensor orientation); the preview is shown portrait.
  const aspect = format ? format.height / format.width : 9 / 16;
  let width = view.width;
  let height = width / aspect;
  if (height > view.height) {
    height = view.height;
    width = height * aspect;
  }
  return { left: (view.width - width) / 2, top: (view.height - height) / 2, width, height };
}

/** `file:///…/swing_123.mp4` → `swing_123` (the library's id). */
const swingIdFromUri = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1).replace(/\.mp4$/, '');

function instruction(state: EngineState, auto: boolean) {
  switch (state) {
    case 'idle':
      return 'Starting camera…';
    case 'triggered':
    case 'exporting':
      return 'Saving your swing…';
    case 'armed':
      return auto
        ? 'Stand in the box and hit. Swings save automatically.'
        : 'Swing, then tap SAVE or press a volume button.';
    case 'standby':
      return 'Standby to save battery. Step into the box or tap the screen to resume.';
  }
}

export default function CaptureScreen() {
  const [permission, requestPermission] = useCapturePermissions();

  if (!permission) return <View style={styles.black} />;
  if (!permission.granted) {
    return <PermissionGate canAsk={permission.canAskAgain} onRequest={requestPermission} />;
  }
  return <Recorder />;
}

function Recorder() {
  useKeepAwake();
  const theme = useTheme();
  const [settings, setSettings] = useState<CaptureSettings>(loadCaptureSettings);
  // Read by the focus effect so returning to the tab restarts with current preferences.
  const settingsRef = useRef(settings);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<ClipReadyEvent | null>(null);
  const [lastSwing, setLastSwing] = useState(latestSwing);
  const [sessionCount, setSessionCount] = useState(0);
  const [lastSound, setLastSound] = useState<SoundEvent | null>(null);
  const [motion, setMotion] = useState<MotionEvent | null>(null);
  const [exposure, setExposure] = useState<ExposureEvent | null>(null);
  const [viewLayout, setViewLayout] = useState<LayoutRectangle | null>(null);
  // Screen y where the top controls end and the bottom bar starts; the golfer box stays between.
  const [topControlsBottom, setTopControlsBottom] = useState(0);
  const [bottomBarTop, setBottomBarTop] = useState<number | null>(null);
  const [showLevels, setShowLevels] = useState(false);
  const [showHelp, setShowHelp] = useState(!settings.seenHelp);
  /** The hint that has faded out; a different hint (new state) shows again. */
  const [fadedHint, setFadedHint] = useState<string | null>(null);
  const stateEvent = useEvent(SwingCapture, 'onStateChange');
  const state = stateEvent?.state ?? 'idle';
  const format = stateEvent?.format;

  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  const updateSettings = (patch: Partial<CaptureSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveCaptureSettings(next);
  };

  // Idle handling: dim between shots, low-power standby when nobody is around.
  const [phase, setPhase] = useState<IdlePhase>('active');
  // Set by markActive() when the tab gains focus, before the idle timer first ticks.
  const lastActivityRef = useRef(0);
  const replayOpenRef = useRef(false);
  /** Engine has actually entered standby since the last wake (to spot wakes from remote / watch). */
  const sawStandbyRef = useRef(false);

  const markActive = useCallback(() => {
    lastActivityRef.current = Date.now();
    setPhase((p) => (p === 'active' ? p : 'active'));
  }, []);

  // Run the camera only while this tab is focused, with whatever Settings now says.
  useFocusEffect(
    useCallback(() => {
      setError(null);
      markActive();
      const current = loadCaptureSettings();
      settingsRef.current = current;
      setSettings(current);
      pruneOldSwings(current.autoDeleteDays);
      setLastSwing(latestSwing());
      SwingCapture.startAsync(captureConfig(current)).catch((e: Error) => setError(e.message));
      return () => {
        SwingCapture.stopAsync().catch(() => {});
        restoreScreen();
      };
    }, [markActive])
  );

  useEffect(() => {
    const subs = [
      SwingCapture.addListener('onError', (e) => setError(e.message)),
      // A new swing interrupts the replay so the golfer sees the latest one.
      SwingCapture.addListener('onTrigger', () => {
        markActive();
        setClip(null);
      }),
      SwingCapture.addListener('onClipReady', (c) => {
        markActive();
        setSessionCount((n) => n + 1);
        setLastSwing({ id: swingIdFromUri(c.uri), thumbUri: c.thumbUri });
        setError(null);
        setClip(c);
      }),
      SwingCapture.addListener('onSound', setLastSound),
      SwingCapture.addListener('onMotion', (m) => {
        setMotion(m);
        // Someone moving in the golfer box: about to swing, or stepping up from standby.
        if (m.level >= m.threshold) markActive();
      }),
      // A remote / watch press wakes the engine natively; catch up with it.
      SwingCapture.addListener('onStateChange', (e) => {
        if (e.state === 'standby') sawStandbyRef.current = true;
        if (e.state === 'armed' && sawStandbyRef.current) {
          sawStandbyRef.current = false;
          markActive();
        }
      }),
      SwingCapture.addListener('onExposure', setExposure),
      SwingCapture.addListener('onThermalDowngrade', (e) =>
        setError(`Phone is hot, dropped from ${e.fromFps} to ${e.toFps} fps`)
      ),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [markActive]);

  useEffect(() => {
    replayOpenRef.current = clip != null;
  }, [clip]);

  // Once a second, work out how idle we are (a replay on screen counts as activity).
  useEffect(() => {
    const timer = setInterval(() => {
      if (replayOpenRef.current) lastActivityRef.current = Date.now();
      const next = idlePhase(Date.now() - lastActivityRef.current, settingsRef.current);
      setPhase((p) => (p === next ? p : next));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Apply the phase: screen brightness and camera power.
  const dimOpts = { dimScreen: settings.dimScreen, autoStandby: settings.autoStandby };
  const dim = shouldDim(phase, dimOpts);
  useEffect(() => {
    if (dim) dimScreen();
    else restoreScreen();
  }, [dim]);
  useEffect(() => {
    SwingCapture.setStandby(phase === 'standby');
  }, [phase]);

  // A replay left open over the camera looks like a frozen preview (the player pauses while the app
  // is in the background), so always come back to the live view.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        setClip(null);
        restoreScreen();
      } else {
        markActive();
      }
    });
    return () => sub.remove();
  }, [markActive]);

  useEffect(() => {
    if (!clip) return;
    const timer = setTimeout(() => setClip(null), REPLAY_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [clip]);

  // Show the hint whenever what it says changes; fade it once the camera is just recording.
  const hintKey = `${state}|${settings.soundTrigger}|${clip ? 'replay' : 'live'}`;
  const hintVisible = fadedHint !== hintKey;
  useEffect(() => {
    if (!hintKey.startsWith('armed|') || hintKey.endsWith('|replay')) return;
    const timer = setTimeout(() => setFadedHint(hintKey), HINT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [hintKey]);

  useEffect(() => {
    if (!clip) {
      player.pause();
      return;
    }
    player
      .replaceAsync(clip.uri)
      .then(() => {
        player.playbackRate = REPLAY_RATE;
        player.play();
      })
      .catch((e: Error) => setError(e.message));
  }, [clip, player]);

  const onSave = () => {
    if (state === 'standby') {
      markActive();
      return;
    }
    try {
      SwingCapture.trigger('manual');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onToggleAuto = () => {
    const soundTrigger = !settingsRef.current.soundTrigger;
    SwingCapture.setImpactTrigger(soundTrigger);
    updateSettings({ soundTrigger });
  };

  const onRoiChange = (roi: NormalizedRect) => {
    const clamped = clampRoi(roi, bounds);
    SwingCapture.setRoi(clamped);
    updateSettings({ roi: clamped });
  };

  const closeHelp = () => {
    setShowHelp(false);
    if (!settingsRef.current.seenHelp) updateSettings({ seenHelp: true });
  };

  const saving = state === 'triggered' || state === 'exporting';
  const statusColor = state === 'armed' ? '#FF3B30' : saving ? '#FFB020' : '#9BA1A6';
  const statusLabel =
    state === 'armed' ? 'Recording' : saving ? 'Saving' : state === 'standby' ? 'Standby' : 'Starting';
  const frame = viewLayout ? previewFrame(viewLayout, format) : null;
  const bounds: RoiBounds =
    frame && bottomBarTop != null
      ? {
          minY: Math.max(0, (topControlsBottom + BOX_GAP - frame.top) / frame.height),
          maxY: Math.min(1, (bottomBarTop - BOX_GAP - frame.top) / frame.height),
        }
      : FULL_BOUNDS;
  // What the box (and the motion gate) actually uses on this screen.
  const effectiveRoi = clampRoi(settings.roi, bounds);
  const roiKey = `${effectiveRoi.x}|${effectiveRoi.y}|${effectiveRoi.width}|${effectiveRoi.height}`;

  // The stored box may not fit this screen's clear area; keep the motion gate on what's drawn.
  useEffect(() => {
    if (state !== 'armed') return;
    const [x, y, width, height] = roiKey.split('|').map(Number);
    SwingCapture.setRoi({ x, y, width, height });
  }, [roiKey, state]);

  return (
    <View style={styles.black} onTouchStart={markActive}>
      <SwingCaptureView style={StyleSheet.absoluteFill} onLayout={(e) => setViewLayout(e.nativeEvent.layout)} />

      {frame && !clip && (
        <GolferBox
          frame={frame}
          bounds={bounds}
          roi={effectiveRoi}
          onChange={onRoiChange}
          active={!!motion && motion.level >= motion.threshold}
          activeColor={theme.accent}
        />
      )}

      {state === 'standby' && !clip && (
        <View style={styles.standby} pointerEvents="none">
          <ThemedText style={styles.standbyTitle}>Standby</ThemedText>
          <ThemedText style={styles.standbyText}>Step into the box or tap the screen to resume recording.</ThemedText>
        </View>
      )}

      {clip && (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setClip(null)}>
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
        </Pressable>
      )}

      {/* Top: status + one instruction. Tap the pill for live levels. */}
      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <View
          style={styles.topRow}
          pointerEvents="box-none"
          onLayout={(e) => setTopControlsBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${statusLabel}. Show levels`}
            onPress={() => setShowLevels((v) => !v)}
            style={styles.pill}>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <ThemedText style={styles.pillText}>{clip ? 'Replay · ¼ speed' : statusLabel}</ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="How it works"
            onPress={() => setShowHelp(true)}
            hitSlop={8}
            style={styles.helpButton}>
            <ThemedText style={styles.helpText}>?</ThemedText>
          </Pressable>
        </View>
        {hintVisible && (
          <Animated.View entering={FadeIn} exiting={FadeOut} pointerEvents="none">
            <ThemedText type="small" style={styles.instruction}>
              {clip ? 'Tap the video to go back to the camera.' : instruction(state, settings.soundTrigger)}
            </ThemedText>
          </Animated.View>
        )}
        {error && (
          <ThemedText type="small" style={[styles.instruction, styles.error]} pointerEvents="none">
            {error}
          </ThemedText>
        )}
        {showLevels && (
          <View style={styles.levels} pointerEvents="none">
            {format && (
              <ThemedText type="small" style={styles.levelText}>
                {`Camera ${format.height}×${format.width} @ ${format.fps} fps${format.highSpeed ? ' (high-speed)' : ''}`}
              </ThemedText>
            )}
            {exposure && (
              <ThemedText type="small" style={styles.levelText}>
                {`Shutter ${formatShutter(exposure.shutterSec)}${exposure.iso ? ` · ISO ${exposure.iso}` : ''}${
                  exposure.shutterSec > 1 / 1000 ? ' (club may blur)' : ''
                }`}
              </ThemedText>
            )}
            <ThemedText type="small" style={styles.levelText}>
              {motion
                ? `Movement in box ${motion.level.toFixed(1)} (swing needs ${motion.threshold.toFixed(1)})`
                : 'Movement in box: measuring…'}
            </ThemedText>
            <ThemedText type="small" style={styles.levelText}>
              {lastSound ? describeSound(lastSound) : 'No sharp sounds yet'}
            </ThemedText>
          </View>
        )}
      </SafeAreaView>

      {/* Bottom: camera-style controls, kept to the edge so the frame stays clear. */}
      <View
        style={styles.bottom}
        pointerEvents="box-none"
        onLayout={(e) => setBottomBarTop(e.nativeEvent.layout.y)}>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: settings.soundTrigger }}
          accessibilityLabel="Auto-save when a ball is hit"
          onPress={onToggleAuto}
          style={[styles.sideControl, styles.autoChip, settings.soundTrigger && { borderColor: theme.accent }]}>
          <ThemedText style={[styles.autoTitle, settings.soundTrigger && { color: theme.accent }]}>AUTO</ThemedText>
          <ThemedText style={styles.autoState}>{settings.soundTrigger ? 'On' : 'Off'}</ThemedText>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Save the last ${settings.lookbackSec} seconds`}
          disabled={state !== 'armed' && state !== 'standby'}
          onPress={onSave}
          style={({ pressed }) => [
            styles.saveButton,
            {
              backgroundColor: theme.accent,
              opacity: state !== 'armed' && state !== 'standby' ? 0.4 : pressed ? 0.7 : 1,
            },
          ]}>
          <ThemedText style={styles.saveLabel}>SAVE</ThemedText>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            lastSwing ? `Open last swing. ${sessionCount} saved this session` : 'No swings saved yet'
          }
          disabled={!lastSwing}
          onPress={() => lastSwing && router.push({ pathname: '/swing/[id]', params: { id: lastSwing.id } })}
          style={[styles.sideControl, styles.thumb]}>
          {lastSwing?.thumbUri && (
            <View style={styles.thumbClip}>
              <Image source={lastSwing.thumbUri} style={StyleSheet.absoluteFill} contentFit="cover" />
            </View>
          )}
          {sessionCount > 0 && (
            <View style={[styles.countBadge, { backgroundColor: theme.accent }]}>
              <ThemedText style={styles.countText}>{sessionCount}</ThemedText>
            </View>
          )}
        </Pressable>
      </View>

      <CaptureHelp visible={showHelp} onClose={closeHelp} lookbackSec={settings.lookbackSec} />
    </View>
  );
}

function PermissionGate({ canAsk, onRequest }: { canAsk: boolean; onRequest: () => void }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.gate, { backgroundColor: theme.background }]}>
      <ThemedText type="subtitle">Camera & microphone</ThemedText>
      <ThemedText themeColor="textSecondary">
        SimpleSwing records your swing with the camera and listens for the sound of impact. Nothing
        leaves your phone.
      </ThemedText>
      {canAsk ? (
        <Pressable onPress={onRequest} style={[styles.gateButton, { backgroundColor: theme.accent }]}>
          <ThemedText style={styles.gateButtonText}>Allow access</ThemedText>
        </Pressable>
      ) : (
        <ThemedText themeColor="danger">
          Access was denied. Enable Camera and Microphone for SimpleSwing in system Settings.
        </ThemedText>
      )}
    </SafeAreaView>
  );
}

const SIDE = 56;
/** Space between the golfer box and the controls above / below it. */
const BOX_GAP = 12;
const SCRIM = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: Spacing.three, gap: Spacing.one },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.two },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one + 2,
    borderRadius: 20,
    backgroundColor: SCRIM,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pillText: { color: '#fff', fontWeight: '600', fontSize: 15, lineHeight: 20 },
  helpButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: SCRIM,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpText: { color: '#fff', fontWeight: '700', fontSize: 18, lineHeight: 22 },
  instruction: {
    alignSelf: 'flex-start',
    color: '#fff',
    backgroundColor: SCRIM,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
  error: { color: '#FF8A80' },
  standby: {
    position: 'absolute',
    left: Spacing.five,
    right: Spacing.five,
    top: '38%',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  standbyTitle: { color: '#fff', fontSize: 24, lineHeight: 30, fontWeight: '700' },
  standbyText: { color: '#fff', textAlign: 'center' },
  levels: { alignSelf: 'flex-start', backgroundColor: SCRIM, borderRadius: Spacing.two, padding: Spacing.two, gap: 2 },
  levelText: { color: '#fff', fontSize: 12, lineHeight: 16 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sideControl: { width: SIDE, height: SIDE, borderRadius: 12 },
  autoChip: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: SCRIM,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoTitle: { color: '#fff', fontWeight: '800', fontSize: 12, lineHeight: 15 },
  autoState: { color: '#fff', fontSize: 12, lineHeight: 15 },
  saveButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveLabel: { color: '#fff', fontWeight: '800', fontSize: 15, lineHeight: 18 },
  thumb: {
    overflow: 'visible',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.8)',
    backgroundColor: SCRIM,
  },
  thumbClip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 10, overflow: 'hidden' },
  countBadge: {
    position: 'absolute',
    top: -8,
    right: -8,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { color: '#fff', fontWeight: '700', fontSize: 12, lineHeight: 16 },
  gate: { flex: 1, padding: Spacing.four, gap: Spacing.three, justifyContent: 'center' },
  gateButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  gateButtonText: { color: '#fff', fontWeight: '700' },
});

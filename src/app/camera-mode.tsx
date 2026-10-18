import { useEvent } from 'expo';
import { useKeepAwake } from 'expo-keep-awake';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PermissionGate } from '@/components/permission-gate';
import { Segmented } from '@/components/segmented';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useCapturePermission } from '@/hooks/use-capture-permission';
import { useTheme } from '@/hooks/use-theme';
import {
  CAMERA_VIEW_OPTIONS,
  LOOKBACK_OPTIONS,
  POST_ROLL_SEC,
  PRE_ROLL_OPTIONS,
  SENSITIVITY_VALUE,
  type CaptureSettings,
} from '@/lib/capture-settings';
import { loadCaptureSettings, saveCaptureSettings } from '@/lib/capture-settings-store';
import { friendlyEngineError, friendlyEngineFailure } from '@/lib/engine-errors';
import { MAX_CONTENT_WIDTH } from '@/lib/layout';
import { formatSync, VIEW_LABEL } from '@/lib/multicam';
import { dimScreen, restoreScreen } from '@/lib/screen-dimmer';
import SwingCapture, {
  SwingCaptureView,
  type CameraView,
  type CaptureConfig,
  type PeerStatusEvent,
} from '../../modules/swing-capture';

/** Nobody touches the camera phone once it's on its tripod. */
const DIM_AFTER_MS = 30_000;

/**
 * The camera phone records only what the main phone asks for, so it keeps the longest buffer any
 * main phone setting could need and never triggers on its own.
 */
function cameraConfig(s: CaptureSettings): CaptureConfig {
  return {
    fps: s.fps,
    preRollSec: Math.max(...PRE_ROLL_OPTIONS),
    postRollSec: POST_ROLL_SEC,
    lookbackSec: Math.max(...LOOKBACK_OPTIONS),
    roi: s.roi,
    sensitivity: SENSITIVITY_VALUE[s.sensitivity],
    sharpMode: s.sharpMode,
    autoTrigger: false,
    impactTrigger: false,
    watchMode: 'off',
    savePracticeSwings: false,
    // The main phone chimes; this one sits on a tripod.
    savedSound: false,
  };
}

/** "482913" → "482 913": easier to read across from a tripod. */
const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Back to where camera mode was opened from, or the tabs after a cold start. */
const leave = () => (router.canGoBack() ? router.back() : router.replace('/settings'));

export default function CameraModeScreen() {
  const [permission, requestPermission] = useCapturePermission();

  if (!permission) return <View style={styles.black} />;
  if (!permission.granted) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <PermissionGate
          why="This phone needs the camera to film the second angle."
          canAsk={permission.canAskAgain}
          onRequest={requestPermission}
          onClose={leave}
        />
      </>
    );
  }
  return <CameraPhone />;
}

function CameraPhone() {
  useKeepAwake();
  const theme = useTheme();
  const [view, setView] = useState<CameraView>(() => loadCaptureSettings().cameraView);
  const [status, setStatus] = useState<PeerStatusEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filmed, setFilmed] = useState(0);
  const stateEvent = useEvent(SwingCapture, 'onStateChange');
  const state = stateEvent?.state ?? 'idle';
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    restoreScreen();
    if (dimTimer.current) clearTimeout(dimTimer.current);
    dimTimer.current = setTimeout(dimScreen, DIM_AFTER_MS);
  }, []);

  useFocusEffect(
    useCallback(() => {
      const s = loadCaptureSettings();
      // Role first, so the engine starts as a camera (no watch, no local triggers).
      SwingCapture.startCameraLink(s.cameraView);
      SwingCapture.startAsync(cameraConfig(s)).catch((e: unknown) => setError(friendlyEngineFailure(e)));
      wake();
      return () => {
        SwingCapture.stopPeerLink();
        SwingCapture.stopAsync().catch(() => {});
        if (dimTimer.current) clearTimeout(dimTimer.current);
        restoreScreen();
      };
    }, [wake])
  );

  // Never leave the phone dimmed (or a stale saved brightness, on iOS) when the app is left.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        wake();
      } else {
        if (dimTimer.current) clearTimeout(dimTimer.current);
        restoreScreen();
      }
    });
    return () => sub.remove();
  }, [wake]);

  /** Whether the main phone was connected at the last status, to spot the link coming or going. */
  const wasConnected = useRef(false);

  useEffect(() => {
    const subs = [
      SwingCapture.addListener('onPeerStatus', (s) => {
        if (s.role !== 'camera') return;
        setStatus(s);
        // The link dropped (or came back): bring the brightness up so the code and "Waiting…" can be
        // read from the tee, 3 m away, then let the dim timer run again.
        const nowConnected = s.state === 'connected';
        if (nowConnected !== wasConnected.current) {
          wasConnected.current = nowConnected;
          wake();
        }
      }),
      SwingCapture.addListener('onError', (e) => setError(friendlyEngineError(e.code, e.message))),
      SwingCapture.addListener('onStateChange', (e) => {
        if (e.state === 'exporting') setFilmed((n) => n + 1);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [wake]);

  const changeView = (next: CameraView) => {
    setView(next);
    saveCaptureSettings({ ...loadCaptureSettings(), cameraView: next });
    SwingCapture.startCameraLink(next);
  };

  const connected = status?.state === 'connected';
  const code = status?.code ?? null;
  const sync = formatSync(status?.syncMs ?? null);
  const engineLabel =
    state === 'armed'
      ? 'Recording'
      : state === 'triggered' || state === 'exporting'
        ? 'Sending swing…'
        : state === 'standby'
          ? 'Resting until the main phone records'
          : 'Starting camera…';

  return (
    <View style={styles.black} onTouchStart={wake}>
      <Stack.Screen options={{ headerShown: false }} />
      <SwingCaptureView style={StyleSheet.absoluteFill} />

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: connected ? theme.accent : '#FFB020' }]} />
            <ThemedText style={styles.title}>
              {connected ? `Connected to ${status?.peerName ?? 'main phone'}` : 'Waiting for the main phone…'}
            </ThemedText>
          </View>
          {connected ? (
            <ThemedText type="small" style={styles.text}>
              {engineLabel}
              {sync ? ` · in sync ${sync}` : ''}
              {filmed > 0 ? ` · ${filmed} swing${filmed === 1 ? '' : 's'} sent` : ''}
            </ThemedText>
          ) : (
            <>
              {code && (
                <ThemedText
                  style={styles.code}
                  maxFontSizeMultiplier={1.3}
                  accessibilityLabel={`Code ${code.split('').join(' ')}`}>
                  {`Code ${spacedCode(code)}`}
                </ThemedText>
              )}
              <ThemedText type="small" style={styles.text}>
                On the main phone, tap the camera icon at the top of Capture, pick this phone and enter this code.
                Both phones need the same Wi-Fi or hotspot.
                {status?.address ? `\nIf it isn't listed, type ${status.address}` : ''}
              </ThemedText>
            </>
          )}
          {error && (
            <ThemedText type="small" style={styles.error}>
              {error}
            </ThemedText>
          )}
        </View>
      </SafeAreaView>

      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        <View style={styles.card}>
          <ThemedText type="small" style={styles.text}>
            This phone films {VIEW_LABEL[view].toLowerCase()}
          </ThemedText>
          <Segmented
            accessibilityLabel="This camera's view"
            value={view}
            onChange={changeView}
            options={CAMERA_VIEW_OPTIONS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
          />
          <Pressable
            accessibilityRole="button"
            onPress={leave}
            style={({ pressed }) => [styles.button, styles.exit, { opacity: pressed ? 0.7 : 1 }]}>
            <ThemedText style={styles.buttonText}>Stop camera mode</ThemedText>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const SCRIM = 'rgba(0,0,0,0.6)';

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, padding: Spacing.three },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: Spacing.three },
  // Centred and no wider than a phone on a tablet, so the code stays readable from the tee.
  card: {
    backgroundColor: SCRIM,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { color: '#fff', fontWeight: '700', flexShrink: 1 },
  text: { color: '#fff' },
  error: { color: '#FF8A80' },
  code: { color: '#fff', fontSize: 34, lineHeight: 42, fontWeight: '800', letterSpacing: 3, fontVariant: ['tabular-nums'] },
  button: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
    alignItems: 'center',
  },
  exit: { backgroundColor: 'rgba(255,255,255,0.2)' },
  buttonText: { color: '#fff', fontWeight: '700' },
});

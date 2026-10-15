import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Segmented } from '@/components/segmented';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  AUTO_DELETE_OPTIONS,
  FPS_OPTIONS,
  LOOKBACK_OPTIONS,
  PRE_ROLL_OPTIONS,
  type CaptureSettings,
  type Sensitivity,
} from '@/lib/capture-settings';
import { loadCaptureSettings, saveCaptureSettings } from '@/lib/capture-settings-store';
import { formatBytes } from '@/lib/swing-library';
import { listSwings, pruneOldSwings } from '@/lib/swing-store';
import SwingCapture from '../../../modules/swing-capture';

const SENSITIVITY_HELP: Record<Sensitivity, string> = {
  low: 'Only loud strikes count. Best at a busy range.',
  medium: 'Works for most ranges.',
  high: 'Softer strikes count too. Good for a quiet range, a net or a mat at home.',
};

export default function SettingsScreen() {
  const theme = useTheme();
  const [settings, setSettings] = useState<CaptureSettings>(loadCaptureSettings);
  const [supportedFps, setSupportedFps] = useState<number[] | null>(null);
  const [storage, setStorage] = useState({ count: 0, bytes: 0 });

  const refreshStorage = useCallback(() => {
    const swings = listSwings();
    setStorage({ count: swings.length, bytes: swings.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0) });
  }, []);

  useFocusEffect(
    useCallback(() => {
      setSettings(loadCaptureSettings());
      refreshStorage();
      SwingCapture.getCapabilitiesAsync()
        .then((c) => setSupportedFps(c.supportedFps))
        .catch(() => setSupportedFps(null));
    }, [refreshStorage])
  );

  const update = (patch: Partial<CaptureSettings>) => {
    // Merge onto what's stored: the second-camera link saves its own fields in the background.
    const next = { ...loadCaptureSettings(), ...patch };
    setSettings(next);
    saveCaptureSettings(next);
    if (patch.autoDeleteDays !== undefined) {
      pruneOldSwings(next.autoDeleteDays);
      refreshStorage();
    }
  };

  // The camera picks the best rate it can sustain, so unsupported choices are shown but disabled.
  const fpsSupported = (fps: number) => supportedFps == null || supportedFps.length === 0 || supportedFps.includes(fps);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText type="subtitle">Settings</ThemedText>

          <Section title="Recording">
            <Setting
              label="Frame rate"
              help="Higher is smoother slow motion of the club, but warms the phone and uses more storage.">
              <Segmented
                accessibilityLabel="Frame rate"
                value={settings.fps}
                onChange={(fps) => update({ fps })}
                options={FPS_OPTIONS.map((fps) => ({ value: fps, label: `${fps} fps`, disabled: !fpsSupported(fps) }))}
              />
            </Setting>
            <Setting inline label="Sharp mode" help="Faster shutter for a crisper club and ball, slightly darker video. Best outdoors.">
              <Switch value={settings.sharpMode} onValueChange={(sharpMode) => update({ sharpMode })} />
            </Setting>
          </Section>

          <Section title="Clip length">
            <Setting label="Auto-saved swings keep" help="Seconds before impact (plus 1.5 s after).">
              <Segmented
                accessibilityLabel="Seconds before impact"
                value={settings.preRollSec}
                onChange={(preRollSec) => update({ preRollSec })}
                options={PRE_ROLL_OPTIONS.map((s) => ({ value: s, label: `${s} s` }))}
              />
            </Setting>
            <Setting label="SAVE button keeps" help="The last few seconds before you press SAVE, a volume button or a remote.">
              <Segmented
                accessibilityLabel="Seconds kept by SAVE"
                value={settings.lookbackSec}
                onChange={(lookbackSec) => update({ lookbackSec })}
                options={LOOKBACK_OPTIONS.map((s) => ({ value: s, label: `${s} s` }))}
              />
            </Setting>
          </Section>

          <Section title="Auto-save">
            <Setting inline label="Save when a ball is hit">
              <Switch value={settings.soundTrigger} onValueChange={(soundTrigger) => update({ soundTrigger })} />
            </Setting>
            <Setting label="Impact sensitivity" help={SENSITIVITY_HELP[settings.sensitivity]}>
              <Segmented
                accessibilityLabel="Impact sensitivity"
                value={settings.sensitivity}
                onChange={(sensitivity) => update({ sensitivity })}
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ]}
              />
            </Setting>
          </Section>

          <Section title="Watch">
            <Setting
              label="Use the watch to"
              help={
                settings.watchMode === 'auto'
                  ? 'Open SimpleSwing on your watch. It senses your swing on the wrist, so only your own shots save, even at a busy range.'
                  : settings.watchMode === 'tap'
                    ? 'The watch is a remote: tap SAVE after your swing.'
                    : 'The watch is ignored.'
              }>
              <Segmented
                accessibilityLabel="Watch mode"
                value={settings.watchMode}
                onChange={(watchMode) => update({ watchMode })}
                options={[
                  { value: 'auto', label: 'Sense swings' },
                  { value: 'tap', label: 'Tap to save' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </Setting>
            <Setting
              inline
              label="Save practice swings"
              help="Save swings without a ball too (sensed on the wrist, no impact sound needed).">
              <Switch
                value={settings.savePracticeSwings && settings.watchMode === 'auto'}
                disabled={settings.watchMode !== 'auto'}
                onValueChange={(savePracticeSwings) => update({ savePracticeSwings })}
              />
            </Setting>
          </Section>

          <Section title="Second camera">
            <Setting
              label="Film a second angle"
              help="Use another phone with SimpleSwing as a second camera, face on or down the line. On the phone you swing with, tap + Cam on the Capture screen; every swing it saves is filmed from both.">
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/camera-mode')}
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
                ]}>
                <ThemedText>Use this phone as the camera</ThemedText>
              </Pressable>
            </Setting>
          </Section>

          <Section title="Battery">
            <Setting inline label="Dim screen between shots" help="After 30 seconds with nobody moving in the golfer box.">
              <Switch value={settings.dimScreen} onValueChange={(dimScreen) => update({ dimScreen })} />
            </Setting>
            <Setting
              inline
              label="Standby when you step away"
              help="After 5 minutes, the camera rests. Stepping into the box, tapping the screen, SAVE, a remote or the watch wakes it in about a second.">
              <Switch value={settings.autoStandby} onValueChange={(autoStandby) => update({ autoStandby })} />
            </Setting>
          </Section>

          <Section title="Storage">
            <ThemedText type="small" themeColor="textSecondary">
              {storage.count === 0
                ? 'No swings saved.'
                : `${storage.count} swing${storage.count === 1 ? '' : 's'} · ${formatBytes(storage.bytes)} on this phone`}
            </ThemedText>
            <Setting label="Delete swings older than" help="Favourites are never deleted, and swings you saved to Photos stay there.">
              <Segmented
                accessibilityLabel="Delete swings older than"
                value={settings.autoDeleteDays}
                onChange={(autoDeleteDays) => update({ autoDeleteDays })}
                options={AUTO_DELETE_OPTIONS.map((d) => ({ value: d, label: d === 0 ? 'Never' : `${d} days` }))}
              />
            </Setting>
          </Section>

          <Section title="Help">
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/help')}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText>Help & tips</ThemedText>
            </Pressable>
            <ThemedText type="small" themeColor="textSecondary">
              Camera set-up, reading your swing (plane lines, head movement, tempo), tags and
              troubleshooting.
            </ThemedText>
          </Section>

          <View style={[styles.about, { borderTopColor: theme.backgroundSelected }]}>
            <ThemedText type="small" themeColor="textSecondary">
              No account. No cloud. Your swings stay on this phone.
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Version {Constants.expoConfig?.version}
            </ThemedText>
          </View>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
        {title.toUpperCase()}
      </ThemedText>
      {children}
    </View>
  );
}

/** A labelled control; [inline] puts a small control (a switch) beside the label. */
function Setting({
  label,
  help,
  inline = false,
  children,
}: {
  label: string;
  help?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.setting}>
      <View style={inline ? styles.inline : styles.stacked}>
        <ThemedText style={inline ? styles.inlineLabel : undefined}>{label}</ThemedText>
        {children}
      </View>
      {help && (
        <ThemedText type="small" themeColor="textSecondary">
          {help}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.four, gap: Spacing.four },
  section: { gap: Spacing.three },
  sectionTitle: { letterSpacing: 0.8 },
  setting: { gap: Spacing.one },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.three },
  inlineLabel: { flex: 1 },
  stacked: { gap: Spacing.two },
  button: { paddingVertical: Spacing.three, borderRadius: Spacing.three, alignItems: 'center' },
  about: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.three, gap: Spacing.one },
});

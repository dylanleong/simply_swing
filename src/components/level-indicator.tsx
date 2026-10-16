import { Accelerometer } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { levelAdvice, smoothTilt, tiltFromGravity, type Tilt } from '@/lib/level';

const UPDATE_MS = 100;
/** How long "Level ✓" stays after the phone is straightened. */
const LEVEL_SHOWN_MS = 2500;

/**
 * Camera setup check: says when the phone is tilted or aimed off level, with a horizon line to
 * straighten it by, and confirms briefly once it's level. Quiet otherwise.
 */
export function LevelIndicator({ active }: { active: boolean }) {
  const [tilt, setTilt] = useState<Tilt | null>(null);
  /** Showing "Level ✓" after the phone was straightened. */
  const [justLevelled, setJustLevelled] = useState(false);
  const smoothed = useRef<Tilt | null>(null);
  const wasOff = useRef(false);
  const levelledUntil = useRef(0);

  useEffect(() => {
    if (!active) return;
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    Accelerometer.isAvailableAsync()
      .then((ok) => {
        if (!ok || cancelled) return;
        Accelerometer.setUpdateInterval(UPDATE_MS);
        sub = Accelerometer.addListener(({ x, y, z }) => {
          const next = smoothTilt(smoothed.current, tiltFromGravity(x, y, z));
          smoothed.current = next;
          const now = Date.now();
          if (levelAdvice(next)) {
            wasOff.current = true;
            levelledUntil.current = 0;
          } else if (wasOff.current) {
            wasOff.current = false;
            levelledUntil.current = now + LEVEL_SHOWN_MS;
          }
          setJustLevelled(now < levelledUntil.current);
          setTilt(next);
        });
      })
      // No accelerometer to read: the level check just stays quiet.
      .catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
      smoothed.current = null;
    };
  }, [active]);

  const advice = tilt ? levelAdvice(tilt) : null;

  if (!active || !tilt || (!advice && !justLevelled)) return null;
  return (
    <View style={styles.pill} pointerEvents="none">
      <View style={styles.horizonBox}>
        {/* The true horizon: straighten the phone until it's flat. */}
        <View
          style={[
            styles.horizon,
            { backgroundColor: advice ? '#FFB020' : '#3DCB7A', transform: [{ rotate: `${-tilt.rollDeg}deg` }] },
          ]}
        />
      </View>
      <ThemedText style={styles.text}>{advice ?? 'Level ✓'}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
  },
  horizonBox: { width: 28, height: 20, alignItems: 'center', justifyContent: 'center' },
  horizon: { width: 28, height: 3, borderRadius: 2 },
  text: { color: '#fff', fontSize: 13, lineHeight: 18, flexShrink: 1 },
});

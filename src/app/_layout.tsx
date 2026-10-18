import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useEffect } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useLayout } from '@/hooks/use-layout';
import { recoverScreenBrightness } from '@/lib/screen-dimmer';

/** A cold-start deep link (`simpleswing://swing/<id>`) opens on top of the tabs, so back has somewhere to go. */
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { isLarge } = useLayout();
  // If the app died while Capture had the screen dimmed (iOS), put the user's brightness back.
  useEffect(() => {
    recoverScreenBrightness();
  }, []);
  // Phones stay portrait; tablets, iPads and open foldables turn with the device (see lib/layout.ts).
  // Decided from the window, not the device model, so a foldable locks when closed and frees when open.
  useEffect(() => {
    const lock = isLarge ? ScreenOrientation.unlockAsync() : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    lock.catch(() => {});
  }, [isLarge]);
  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="swing/[id]" options={{ title: 'Swing', headerBackTitle: 'Swings' }} />
          <Stack.Screen name="camera-mode" options={{ headerShown: false }} />
          <Stack.Screen name="compare-pick" options={{ title: 'Compare with…' }} />
          <Stack.Screen name="compare" options={{ title: 'Compare' }} />
          <Stack.Screen name="help" options={{ title: 'Help & tips' }} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

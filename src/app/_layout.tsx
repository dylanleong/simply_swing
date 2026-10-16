import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { recoverScreenBrightness } from '@/lib/screen-dimmer';

/** A cold-start deep link (`simpleswing://swing/<id>`) opens on top of the tabs, so back has somewhere to go. */
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  const colorScheme = useColorScheme();
  // If the app died while Capture had the screen dimmed (iOS), put the user's brightness back.
  useEffect(() => {
    recoverScreenBrightness();
  }, []);
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

import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useLayout } from '@/hooks/use-layout';
import { useTheme } from '@/hooks/use-theme';
import { HELP_TOPICS, helpTopic, type HelpTopicId } from '@/lib/help-topics';

/** Help & tips, by topic. Opened with `?topic=<id>` it starts on that topic, open. */
export default function HelpScreen() {
  const theme = useTheme();
  const { contentWidth } = useLayout();
  const { topic } = useLocalSearchParams<{ topic?: string }>();
  const [open, setOpen] = useState<HelpTopicId | null>(() => helpTopic(topic)?.id ?? null);
  // A linked topic goes first so it's on screen without scrolling.
  const topics = topic ? [...HELP_TOPICS].sort((a, b) => Number(b.id === topic) - Number(a.id === topic)) : HELP_TOPICS;

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Help & tips' }} />
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ScrollView contentContainerStyle={[styles.content, { width: contentWidth, alignSelf: 'center' }]}>
          {topics.map((t) => {
            const expanded = open === t.id;
            return (
              <View key={t.id} style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => setOpen(expanded ? null : t.id)}
                  style={styles.header}>
                  <View style={styles.headerText}>
                    <ThemedText type="smallBold" style={styles.title}>
                      {t.title}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {t.summary}
                    </ThemedText>
                  </View>
                  <ThemedText themeColor="textSecondary">{expanded ? '▲' : '▼'}</ThemedText>
                </Pressable>
                {expanded &&
                  t.sections.map((s) => (
                    <View key={s.heading} style={styles.section}>
                      <ThemedText type="smallBold">{s.heading}</ThemedText>
                      <ThemedText type="small">{s.body}</ThemedText>
                    </View>
                  ))}
              </View>
            );
          })}
          <ThemedText type="small" themeColor="textSecondary" style={styles.footer}>
            Everything stays on your phone. No account, no cloud.
          </ThemedText>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three },
  card: { borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.three },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headerText: { flex: 1, gap: Spacing.half },
  title: { fontSize: 17 },
  section: { gap: Spacing.one },
  footer: { textAlign: 'center' },
});

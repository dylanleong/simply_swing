import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { CodeRequest } from '@/hooks/use-main-peer-link';
import { useTheme } from '@/hooks/use-theme';
import { isPairingCode, PAIRING_CODE_LENGTH, pairingCodeDigits } from '@/lib/capture-settings';
import { formatSync } from '@/lib/multicam';
import type { PeerInfo, PeerStatusEvent } from '../../modules/swing-capture';

/**
 * Main phone: pick the phone that films the second angle. Discovery runs while the sheet's
 * "second camera" mode is on; a typed address is the fallback for networks that block discovery.
 * Picking a phone asks for the 6-digit code it shows (once: it's remembered), in place, no new screen.
 */
export function SecondCameraSheet({
  visible,
  status,
  peers,
  connecting,
  connectError,
  codeRequest,
  onPick,
  onSubmitCode,
  onCancelCode,
  onStop,
  onClose,
}: {
  visible: boolean;
  status: PeerStatusEvent | null;
  peers: PeerInfo[];
  /** The peer id or address being connected to, until it connects or fails. */
  connecting: string | null;
  connectError: string | null;
  /** The phone whose code is being asked for. */
  codeRequest: CodeRequest | null;
  /** A found phone (its id and name) or a typed address. */
  onPick: (idOrAddress: string, name?: string) => void;
  onSubmitCode: (code: string) => void;
  onCancelCode: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const connected = status?.state === 'connected';
  const sync = formatSync(status?.syncMs ?? null);
  const asking = !connected && codeRequest != null;
  const codeReady = isPairingCode(code);

  const pick = (idOrAddress: string, name?: string) => {
    setCode('');
    onPick(idOrAddress, name);
  };
  const submitCode = () => {
    if (!codeReady) return;
    onSubmitCode(code);
    // Empty if it's asked again (a wrong code).
    setCode('');
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Lifts the card above the keyboard (the address and code fields), even on small phones. */}
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <ThemedText type="subtitle" style={styles.title}>
              Second camera
            </ThemedText>

            {connected ? (
              <View style={[styles.connected, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold">Connected to {status?.peerName ?? 'camera phone'}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {status?.peerState === 'standby'
                    ? 'Resting until this phone records.'
                    : `Every swing you save is filmed from both phones${sync ? ` (in sync ${sync})` : ''}.`}
                </ThemedText>
              </View>
            ) : asking ? null : (
              // Hidden while typing the code, so the code field and Connect stay above the keyboard.
              <ThemedText type="small" themeColor="textSecondary">
                Film a second angle with another phone, iPhone or Android. On it, open SimpleSwing → Settings →
                Use this phone as the camera. Put both phones on the same Wi-Fi, or turn on one phone&apos;s
                hotspot and join it from the other. Then pick it here and type the code it shows.
              </ThemedText>
            )}

            {!connected && codeRequest && (
              <View style={[styles.connected, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold">
                  Enter the code shown on {codeRequest.name ?? codeRequest.target}
                </ThemedText>
                {connectError && (
                  <ThemedText type="small" style={{ color: theme.danger }}>
                    {connectError}
                  </ThemedText>
                )}
                <TextInput
                  key={codeRequest.target}
                  value={code}
                  onChangeText={(t) => setCode(pairingCodeDigits(t))}
                  placeholder="000000"
                  placeholderTextColor={theme.textSecondary}
                  accessibilityLabel="Pairing code"
                  autoFocus
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  maxLength={PAIRING_CODE_LENGTH}
                  returnKeyType="go"
                  onSubmitEditing={submitCode}
                  style={[styles.input, styles.codeInput, { color: theme.text, backgroundColor: theme.background }]}
                />
                <View style={styles.addressRow}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={onCancelCode}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}>
                    <ThemedText>Cancel</ThemedText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !codeReady }}
                    disabled={!codeReady}
                    onPress={submitCode}
                    style={({ pressed }) => [
                      styles.button,
                      { backgroundColor: theme.accent, opacity: !codeReady ? 0.4 : pressed ? 0.7 : 1 },
                    ]}>
                    <ThemedText style={styles.buttonText}>Connect</ThemedText>
                  </Pressable>
                </View>
              </View>
            )}

            {!connected && !asking && (connecting || connectError) && (
              <View style={[styles.connected, { backgroundColor: theme.backgroundElement }]}>
                {connecting ? (
                  <ThemedText type="smallBold">
                    Connecting to {peers.find((p) => p.id === connecting)?.name ?? connecting}…
                  </ThemedText>
                ) : (
                  <ThemedText type="small" style={{ color: theme.danger }}>
                    {connectError}
                  </ThemedText>
                )}
              </View>
            )}

            {!connected && !asking && (
              <View style={styles.list}>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  {peers.length === 0 ? 'Looking for camera phones…' : 'Tap to connect'}
                </ThemedText>
                {peers.map((p) => (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    onPress={() => pick(p.id, p.name)}
                    style={({ pressed }) => [
                      styles.peer,
                      { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
                    ]}>
                    <ThemedText>{p.name}</ThemedText>
                    {p.host !== '' && (
                      <ThemedText type="small" themeColor="textSecondary">
                        {p.host}
                      </ThemedText>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            {!connected && !asking && (
              <View style={styles.list}>
                <ThemedText type="small" themeColor="textSecondary">
                  Not listed? Type the address shown on the camera phone.
                </ThemedText>
                <View style={styles.addressRow}>
                  <TextInput
                    value={address}
                    onChangeText={setAddress}
                    placeholder="192.168.1.20"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                    returnKeyType="go"
                    onSubmitEditing={() => address.trim() && pick(address.trim())}
                    style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={!address.trim()}
                    onPress={() => pick(address.trim())}
                    style={({ pressed }) => [
                      styles.smallButton,
                      { backgroundColor: theme.accent, opacity: !address.trim() ? 0.4 : pressed ? 0.7 : 1 },
                    ]}>
                    <ThemedText style={styles.buttonText}>Connect</ThemedText>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              onPress={onStop}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={{ color: theme.danger }}>{connected ? 'Disconnect' : 'Turn off'}</ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.button, { backgroundColor: theme.accent, opacity: pressed ? 0.7 : 1 }]}>
              <ThemedText style={styles.buttonText}>Done</ThemedText>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  card: { borderRadius: Spacing.four, maxHeight: '85%', overflow: 'hidden' },
  content: { padding: Spacing.four, gap: Spacing.three },
  title: { fontSize: 26, lineHeight: 32 },
  connected: { padding: Spacing.three, borderRadius: Spacing.three, gap: Spacing.one },
  list: { gap: Spacing.two },
  peer: { padding: Spacing.three, borderRadius: Spacing.three, gap: Spacing.half },
  addressRow: { flexDirection: 'row', gap: Spacing.two },
  input: { flex: 1, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: Spacing.three },
  codeInput: { flex: 0, fontSize: 28, lineHeight: 34, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
  smallButton: { paddingHorizontal: Spacing.three, justifyContent: 'center', borderRadius: Spacing.three },
  buttons: { flexDirection: 'row', gap: Spacing.two, padding: Spacing.four, paddingTop: 0 },
  button: { flex: 1, paddingVertical: Spacing.three, borderRadius: Spacing.three, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700' },
});

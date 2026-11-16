// Phone: pair with the laptop by scanning the QR code in its Settings → Home, inside Aislet. This is the only way a
// QR code pairs: a link opened by another app or website never does (see pairLink.ts).
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { Button, Dialog, Portal, Text, useTheme } from 'react-native-paper';
import { APP_NAME } from '../config';
import { normaliseAddress, pairWith } from '../hub';
import { parsePairLink } from '../pairLink';
import { useStore } from '../store';

interface Props {
  /** Called with the laptop's name once paired. */
  onPaired?: (name: string) => void;
  mode?: 'contained' | 'contained-tonal';
}

/** "Scan the laptop's code": opens the camera, then pairs with the laptop whose code it reads. */
export function ScanPair({ onPaired, mode = 'contained' }: Props) {
  const theme = useTheme();
  const { updateSettings } = useStore();
  const [open, setOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pairing, setPairing] = useState<string | null>(null); // the address, while pairing
  const [problem, setProblem] = useState<string | null>(null);
  const handled = useRef(''); // the last code read, so the camera doesn't act on it again and again

  const close = () => {
    if (pairing) return;
    setOpen(false);
    setProblem(null);
    handled.current = '';
  };

  const scanned = async (data: string) => {
    if (pairing || data === handled.current) return;
    handled.current = data;
    const link = parsePairLink(data);
    if (!link) {
      setProblem(`That isn't a pairing code. Scan the one in ${APP_NAME} → Settings → Home on the laptop.`);
      return;
    }
    if ('problem' in link) {
      setProblem(link.problem);
      return;
    }
    if ((await Network.getIpAddressAsync().catch(() => '')) === link.address.split(':')[0]) {
      setProblem('That code points to this phone, not your laptop.');
      return;
    }
    setProblem(null);
    setPairing(link.address);
    try {
      const base = normaliseAddress(link.address);
      const { key, name } = await pairWith(base, link.code, link.salt);
      await updateSettings({ hubUrl: base, hubKey: key });
      setPairing(null);
      setOpen(false);
      handled.current = '';
      onPaired?.(name);
    } catch (e) {
      const message = (e as Error).message;
      setPairing(null);
      // The camera still sees the same code: it isn't tried again (and again) until the scanner is reopened.
      setProblem(message === "Couldn't reach the laptop." ? `${message} Check the phone and laptop are on the same Wi-Fi, then tap Scan again.` : message);
    }
  };

  const muted = { color: theme.colors.onSurfaceVariant };
  let body: React.ReactNode;
  if (!permission?.granted) {
    body = (
      <>
        <Text variant="bodyMedium" style={muted}>
          {APP_NAME} needs the camera to read the code. Nothing is recorded or saved.
        </Text>
        {permission && !permission.canAskAgain ? (
          <Button mode="contained-tonal" onPress={() => Linking.openSettings()}>Allow the camera in Settings</Button>
        ) : (
          <Button mode="contained-tonal" onPress={() => requestPermission()}>Allow the camera</Button>
        )}
      </>
    );
  } else {
    body = (
      <>
        <View style={[styles.camera, { backgroundColor: theme.colors.surfaceVariant }]}>
          {pairing ? (
            <View style={styles.pairing}>
              <ActivityIndicator color={theme.colors.primary} />
              <Text variant="bodyMedium">Pairing with {pairing}…</Text>
            </View>
          ) : (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => { scanned(data); }}
            />
          )}
        </View>
        <Text variant="bodyMedium" style={muted}>On the laptop, open {APP_NAME} → Settings → Home, then point this phone at the code.</Text>
      </>
    );
  }

  return (
    <>
      <Button mode={mode} icon="qrcode-scan" onPress={() => setOpen(true)}>Scan the laptop's code</Button>
      <Portal>
        <Dialog visible={open} onDismiss={close} style={styles.dialog}>
          <Dialog.Title>Scan the laptop's code</Dialog.Title>
          <Dialog.Content style={styles.content}>
            {body}
            {problem && <Text variant="bodyMedium" style={{ color: theme.colors.error }}>{problem}</Text>}
          </Dialog.Content>
          <Dialog.Actions>
            {problem && !pairing && (
              <Button onPress={() => { handled.current = ''; setProblem(null); }}>Scan again</Button>
            )}
            <Button onPress={close} disabled={!!pairing}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  dialog: { borderRadius: 24 },
  content: { gap: 12 },
  camera: { aspectRatio: 1, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  pairing: { alignItems: 'center', gap: 12, padding: 16 },
});

// Phone: "Pair with the laptop at …?" when the laptop's QR code (a pairing link) opens the app.
// Any app or website can open a link like this, so it always asks first and shows the address.
import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { Button, Dialog, Portal, Snackbar, Text, useTheme } from 'react-native-paper';
import { hubPing, normaliseAddress } from '../hub';
import { parsePairLink } from '../pairLink';
import { useStore } from '../store';

// Android gives the link that opened the app for as long as the app runs: ask about it once.
let initialChecked = false;

const shortAddress = (url: string) => url.replace(/^https?:\/\//, '').replace(/:8766$/, '');

export function PairPrompt() {
  const theme = useTheme();
  const { settings, updateSettings } = useStore();
  const [link, setLink] = useState<{ address: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const parsed = url ? parsePairLink(url) : null;
      if (!parsed) return;
      if ('problem' in parsed) {
        setToast(parsed.problem);
        return;
      }
      setProblem(null);
      setLink(parsed);
    };
    if (!initialChecked) {
      initialChecked = true;
      Linking.getInitialURL().then(open).catch(() => undefined);
    }
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);

  if (!link) return <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={4000}>{toast}</Snackbar>;

  const base = normaliseAddress(link.address);
  const current = settings.hubUrl && settings.hubKey ? shortAddress(settings.hubUrl) : '';
  const cancel = () => {
    if (!busy) setLink(null);
  };
  const pair = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const info = await hubPing({ base, key: link.code, kind: 'phone' });
      if (!info.paired) throw new Error("The laptop didn't accept this code. It may have a new one: scan the code on the laptop again.");
      await updateSettings({ hubUrl: base, hubKey: link.code });
      setLink(null);
      setToast(`Paired with ${info.name || 'your laptop'}. Chats, memory and notes will sync over your Wi-Fi.`);
    } catch (e) {
      const message = (e as Error).message;
      setProblem(message === "Couldn't reach the laptop." ? `${message} Check the phone and laptop are on the same Wi-Fi.` : message);
    } finally {
      setBusy(false);
    }
  };

  const muted = { color: theme.colors.onSurfaceVariant };
  return (
    <Portal>
      <Dialog visible onDismiss={cancel} style={styles.dialog}>
        <Dialog.Title>Pair with the laptop at {link.address}?</Dialog.Title>
        <Dialog.Content style={styles.content}>
          <Text variant="bodyMedium" style={muted}>
            Chats, memory and notes will sync with it over your Wi-Fi, and this phone can use its AI. Only pair if you've
            just scanned the code on your own laptop.
          </Text>
          {!!current && (
            <Text variant="bodyMedium" style={muted}>
              {current === link.address
                ? 'This phone is already paired with that address. Pairing again uses the new code.'
                : `This replaces the laptop you're paired with now, at ${current}.`}
            </Text>
          )}
          {problem && <Text variant="bodyMedium" style={{ color: theme.colors.error }}>{problem}</Text>}
        </Dialog.Content>
        <Dialog.Actions style={styles.actions}>
          <Button onPress={cancel} disabled={busy}>Cancel</Button>
          <Button mode="contained" onPress={pair} loading={busy} disabled={busy} style={styles.pair}>
            {problem ? 'Try again' : 'Pair'}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  dialog: { borderRadius: 24 },
  content: { gap: 12 },
  actions: { gap: 8 },
  pair: { paddingHorizontal: 8 },
});

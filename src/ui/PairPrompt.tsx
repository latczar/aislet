// Phone: when an aislet://pair link opens the app (for example after the phone's own camera app read the laptop's
// QR code), say where to scan it instead. Nothing pairs from a link: any app or website can open one, and it
// could hold its own address and code (see pairLink.ts).
import React, { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { Snackbar } from 'react-native-paper';
import { APP_NAME } from '../config';
import { parsePairLink } from '../pairLink';

// Android gives the link that opened the app for as long as the app runs: look at it once.
let initialChecked = false;

export const SCAN_IN_APP = `To pair, open Settings → Home in ${APP_NAME} on this phone and tap Scan the laptop's code.`;

export function PairPrompt() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      if (url && parsePairLink(url)) setToast(SCAN_IN_APP);
    };
    if (!initialChecked) {
      initialChecked = true;
      Linking.getInitialURL().then(open).catch(() => undefined);
    }
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);

  return <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={6000}>{toast}</Snackbar>;
}

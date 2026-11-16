// The Android home-screen widget (modules/aislet-widget): its bar opens a new chat, its round button starts
// hands-free. It opens Aislet with aislet://new or aislet://talk plus this install's secret token. Any app or
// website can open aislet:// links, so a link is acted on only when it is exactly one of these two and carries
// the token, which only the widget holds. Anything else is ignored, so no other app can make Aislet listen.
import { requireOptionalNativeModule } from 'expo';
import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';

export type WidgetAction = 'new' | 'talk';

interface NativeWidget {
  token(): string;
  add(): Promise<boolean>;
}

const native = requireOptionalNativeModule<NativeWidget>('AisletWidget');
let initialChecked = false; // the link that started the app is handled once, even if the screen remounts

/** Whether this device has the widget (Android builds from 1.0.8). */
export const widgetSupported = native != null;

/** Ask the home screen to add the widget. False when the home screen can't be asked. */
export async function addWidget(): Promise<boolean> {
  return native ? native.add() : false;
}

/** The action a widget link asks for, or null for any other link, a wrong token, or anything extra. */
export function parseWidgetLink(url: string, token: string): WidgetAction | null {
  const m = /^aislet:\/\/(new|talk)\?k=([0-9a-f]{32})$/.exec(url);
  if (!m || !token || m[2].length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= m[2].charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? (m[1] as WidgetAction) : null;
}

/** Calls `onAction` when the app is opened from the widget, including from cold. */
export function useWidgetLinks(onAction: (action: WidgetAction) => void) {
  const callback = useRef(onAction);
  callback.current = onAction;
  useEffect(() => {
    if (!native) return;
    const widget = native;
    const open = (url: string | null | undefined) => {
      if (!url) return;
      let token = '';
      try {
        token = widget.token();
      } catch {
        return;
      }
      const action = parseWidgetLink(url, token);
      if (action) callback.current(action);
    };
    if (!initialChecked) {
      initialChecked = true;
      Linking.getInitialURL().then(open).catch(() => undefined);
    }
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);
}

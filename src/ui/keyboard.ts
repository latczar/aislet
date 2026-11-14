// Keeps the screen's content above the phone's on-screen keyboard.
//
// Expo apps on Android draw edge to edge, so the window no longer shrinks when the keyboard opens
// (app.json's softwareKeyboardLayoutMode "resize" has no effect). React Native's KeyboardAvoidingView
// also measures itself relative to its parent, not the screen, so inside the phone layout (status bar,
// header and tab bar around it) it padded too little and the message box ended up behind the keyboard.
//
// Instead, a full-screen root measures where its bottom edge is on screen and pads by however much of
// it the keyboard covers. If a phone does resize the window, the root's bottom moves up and the
// padding drops to nothing, so it can't double up.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type ViewInstance } from 'react-native';

export function useKeyboardInset() {
  const ref = useRef<ViewInstance>(null);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [bottom, setBottom] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    // Android re-sends keyboardDidShow when the keyboard's height changes while it's open.
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardTop(e.endCoordinates.screenY));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _w, h) => setBottom(y + h));
  }, []);

  const open = keyboardTop !== null;
  const inset = open ? Math.max(0, Math.round(bottom - keyboardTop)) : 0;
  return { ref, onLayout, inset, open };
}

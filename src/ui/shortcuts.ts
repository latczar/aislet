// PC keyboard shortcuts. The phone has no keyboard shortcuts, so this does nothing there.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export const SHORTCUTS = [
  { keys: 'Ctrl + Shift + O', label: 'New chat' },
  { keys: '/  or  Shift + Esc', label: 'Type a message' },
  { keys: 'Ctrl + K', label: 'Search chats' },
];

// Things a shortcut can put the cursor in. Each screen registers its own while it's shown.
type Target = 'message' | 'search';
const targets: Partial<Record<Target, () => void>> = {};

/** Let a shortcut focus this field; returns a clean-up for useEffect. */
export function registerFocus(name: Target, focus: () => void): () => void {
  targets[name] = focus;
  return () => {
    if (targets[name] === focus) delete targets[name];
  };
}

/** Focus a field once the screen showing it has drawn. */
export function focusSoon(name: Target) {
  setTimeout(() => targets[name]?.(), 60);
}

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export function useShortcuts(actions: { newChat(): void; typeMessage(): void; searchChats(): void }) {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      let run: (() => void) | null = null;
      if (mod && e.shiftKey && !e.altKey && key === 'o') run = latest.current.newChat;
      else if (mod && !e.shiftKey && !e.altKey && key === 'k') run = latest.current.searchChats;
      else if ((e.shiftKey && key === 'escape') || (key === '/' && !mod && !e.altKey && !typingInField(e.target))) run = latest.current.typeMessage;
      if (!run) return;
      e.preventDefault();
      run();
    };
    // Capture phase, so the app's own key handling can't swallow the shortcut first.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

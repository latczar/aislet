// Model downloads shared by the chat set-up card and Settings, so progress shows in both
// and survives switching screens.
import { useSyncExternalStore } from 'react';
import { engine } from '../engine';

interface DownloadState {
  progress: number | null; // 0..1 while downloading
  problem: string | null;
}

const states = new Map<string, DownloadState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let version = 0;

function set(id: string, patch: Partial<DownloadState>) {
  states.set(id, { ...(states.get(id) ?? { progress: null, problem: null }), ...patch });
  version++;
  listeners.forEach((l) => l());
}

export function startDownload(id: string, onDone: () => void) {
  if (!engine.models || controllers.has(id)) return;
  const controller = new AbortController();
  controllers.set(id, controller);
  set(id, { progress: 0, problem: null });
  engine.models
    .download(id, (p) => set(id, { progress: Math.min(1, p) }), controller.signal)
    .then(() => {
      set(id, { progress: null });
      onDone();
    })
    .catch((e: Error) => {
      const cancelled = controller.signal.aborted;
      set(id, { progress: null, problem: cancelled ? null : `${e.message.replace(/\.$/, '')}.` });
    })
    .finally(() => controllers.delete(id));
}

export function cancelDownload(id: string) {
  controllers.get(id)?.abort();
}

export function useDownload(id: string): DownloadState {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return states.get(id) ?? { progress: null, problem: null };
}

// App state: chats, memory, notes and settings, saved on this device and synced with the laptop hub.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  CATEGORIES, MAX_TOKENS, MEMORY_LIMIT, TIDY_BATCH, type TidyChange, chunkText, cleanFact, conversationLearnMessages,
  interviewPrompt, keywordScore, learnMessages, parseFacts, parseTidy, relevantMemories, similarity, stripThinking,
  systemPrompt, tidyMessages, titleFrom, worthLearning,
} from './brain';
import { engine as localEngine } from './engine';
import { createOllamaEngine } from './engine/ollama';
import type { Engine, EngineStatus } from './engine/types';
import { type HubInfo, type HubTarget, STALE_PC_KEY, hubHeaders, hubPing, hubSync, localHub } from './hub';
import { KEYS, load, newId, remove, save, today } from './storage';
import { exportFile, pickFile } from './transfer';
import { setHaptics } from './ui/actions';
import type { Backup, Chat, ChatSummary, Memory, MemoryCategory, Message, Note, NoteHit, Settings } from './types';

const DEFAULT_SETTINGS: Settings = {
  name: '', learn: true, modelId: 'qwen3.5-4b', instructions: '', length: 'balanced', appearance: 'light',
  hubUrl: '', hubKey: '', useLaptop: true, accel: 'cpu', performance: 'balanced', haptics: true, onboarded: false,
};
const HISTORY = 20; // messages of the current chat the model sees
const DELETED_KEY = 'deleted';

type NoteIndex = Record<string, { updated: number; chunks: { text: string; vec?: number[] }[] }>;
type MemoryIndex = Record<string, { fact: string; vec: number[] }>;

export interface Attachments {
  images: string[];                       // base64 JPEG
  files: { name: string; text: string }[]; // text already read from the file
}

export interface HubState {
  connected: boolean; // the laptop answered and we're paired
  name?: string;      // the laptop's name
  lastSync?: number;
  syncing: boolean;
  problem?: string;
}

interface Store {
  loaded: boolean;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  status: EngineStatus | null;
  refreshStatus(): Promise<void>;
  engine: Engine; // the one answering right now
  hub: HubState;
  syncNow(): Promise<void>;
  memories: Memory[];
  addMemory(fact: string, category?: MemoryCategory): Promise<boolean>;
  removeMemory(id: string): Promise<void>;
  /** Ask the model for duplicates, contradictions and overlaps to tidy. Nothing changes until applyTidy. */
  proposeTidy(): Promise<TidyChange[]>;
  applyTidy(changes: TidyChange[]): Promise<void>;
  notes: Note[];
  saveNote(note: { id?: string; title: string; text: string }): Promise<void>;
  deleteNote(id: string): Promise<void>;
  chats: ChatSummary[];
  chat: Chat | null;
  openChat(id: string): Promise<void>;
  newChat(): void;
  deleteChat(id: string): Promise<void>;
  clearChats(): Promise<void>;
  busy: boolean;
  error: string | null;
  clearError(): void;
  noted: Record<number, string[]>; // facts learnt, by message position in the current chat
  send(text: string, attachments?: Attachments): Promise<void>;
  regenerate(): Promise<void>;
  startInterview(): Promise<void>; // a "get to know me" chat
  stop(): void;
  exportData(): Promise<void>;
  importData(): Promise<string | null>; // a summary of what was added, or null if cancelled
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

function withAttachments(text: string, a?: Attachments): Message {
  if (!a || (!a.images.length && !a.files.length)) return { role: 'user', content: text };
  const fileText = a.files
    .map((f) => `\n\n--- Attached file: ${f.name} ---\n${f.text.slice(0, 15000)}${f.text.length > 15000 ? '\n[…the rest of the file was cut to fit]' : ''}`)
    .join('');
  const asked = text || (a.images.length ? 'What can you tell me about this?' : 'Summarise this for me.');
  return {
    role: 'user',
    content: asked + fileText,
    display: text,
    images: a.images.length ? a.images : undefined,
    files: a.files.length ? a.files.map((f) => ({ name: f.name })) : undefined,
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noted, setNoted] = useState<Record<number, string[]>>({});
  const [hub, setHub] = useState<HubState>({ connected: false, syncing: false });

  // Latest values for use inside long-running async work.
  const memRef = useRef(memories);
  memRef.current = memories;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const busyRef = useRef(false);
  const hubRef = useRef(hub);
  hubRef.current = hub;
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  const recheck = useRef<{ timer: ReturnType<typeof setTimeout> | null; tries: number }>({ timer: null, tries: 0 });
  const checkRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);

  // ---- Which engine answers ----
  const remote = useMemo(
    () => (Platform.OS !== 'web' && settings.hubUrl && settings.hubKey
      ? createOllamaEngine({
        base: settings.hubUrl,
        sign: (method, path, body) => hubHeaders({ key: settings.hubKey, kind: 'phone' }, method, path, body),
        where: 'phone',
        label: "Your laptop's AI",
      })
      : null),
    [settings.hubUrl, settings.hubKey],
  );
  const pickEngine = useCallback(
    (connected: boolean): Engine => (remote && connected && settingsRef.current.useLaptop ? remote : localEngine),
    [remote],
  );
  const engine = pickEngine(hub.connected);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const hubTarget = useCallback((): HubTarget | null => {
    const local = localHub();
    if (local) return local;
    const s = settingsRef.current;
    return s.hubUrl && s.hubKey ? { base: s.hubUrl, key: s.hubKey, kind: 'phone' } : null;
  }, []);

  useEffect(() => {
    const opts = { accel: settings.accel, performance: settings.performance };
    localEngine.configure?.(opts);
    remote?.configure?.(opts);
  }, [settings.accel, settings.performance, remote]);

  // ---- Deletions are remembered so sync doesn't bring things back ----
  const markDeleted = useCallback(async (ids: string[]) => {
    const deleted = await load<Record<string, number>>(DELETED_KEY, {});
    const now = Date.now();
    for (const id of ids) deleted[id] = now;
    await save(DELETED_KEY, deleted);
  }, []);

  // ---- Sync with the laptop hub ----
  const syncNow = useCallback(async () => {
    const target = hubTarget();
    if (!target || syncing.current || busyRef.current) return;
    syncing.current = true;
    setHub((h) => ({ ...h, syncing: true }));
    try {
      const index = await load<ChatSummary[]>(KEYS.chats, []);
      const local: Chat[] = [];
      for (const c of index) {
        const full = await load<Chat | null>(KEYS.chat(c.id), null);
        if (full) local.push({ ...full, messages: full.messages.map(({ images: _i, ...m }) => m) });
      }
      const deleted = await load<Record<string, number>>(DELETED_KEY, {});
      const sentMemoryIds = new Set(memRef.current.map((m) => m.id));
      const sentNotes = new Map(notesRef.current.map((n) => [n.id, n.updated]));
      const merged = await hubSync(target, { memories: memRef.current, notes: notesRef.current, chats: local, deleted });

      // Anything added or edited here while the sync was in flight is kept, not overwritten.
      const mergedMemoryIds = new Set(merged.memories.map((m) => m.id));
      const memories = [
        ...merged.memories,
        ...memRef.current.filter((m) => !sentMemoryIds.has(m.id) && !mergedMemoryIds.has(m.id) && merged.deleted[m.id] === undefined),
      ];
      memRef.current = memories;
      setMemories(memories);
      await save(KEYS.memories, memories);
      const notesById = new Map(merged.notes.map((n) => [n.id, n]));
      for (const n of notesRef.current) {
        const changedHere = (sentNotes.get(n.id) ?? -1) < n.updated;
        if (changedHere && (notesById.get(n.id)?.updated ?? -1) < n.updated && (merged.deleted[n.id] ?? -1) < n.updated) notesById.set(n.id, n);
      }
      const notes = [...notesById.values()].sort((a, b) => b.updated - a.updated);
      notesRef.current = notes;
      setNotes(notes);
      await save(KEYS.notes, notes);

      // Chats: take newer copies from the other device, but keep this device's photos.
      const latestIndex = await load<ChatSummary[]>(KEYS.chats, []); // includes chats saved during the sync
      const mine = new Map(latestIndex.map((c) => [c.id, c]));
      for (const c of merged.chats) {
        const have = mine.get(c.id);
        if (have && c.updated <= have.updated) continue;
        const old = have ? await load<Chat | null>(KEYS.chat(c.id), null) : null;
        const withPhotos = old
          ? {
            ...c,
            messages: c.messages.map((m, i) =>
              old.messages[i]?.images && old.messages[i].role === m.role && old.messages[i].content === m.content
                ? { ...m, images: old.messages[i].images }
                : m),
          }
          : c;
        await save(KEYS.chat(c.id), withPhotos); // newer from the other device
      }
      for (const c of latestIndex) {
        if ((merged.deleted[c.id] ?? -1) >= c.updated) await remove(KEYS.chat(c.id)); // deleted on the other device
      }
      const fromHub = new Map(merged.chats.map((c) => [c.id, c]));
      const nextIndex: ChatSummary[] = [
        ...merged.chats.map((c) => ({ id: c.id, title: c.title, updated: Math.max(c.updated, mine.get(c.id)?.updated ?? 0) })),
        ...latestIndex.filter((c) => !fromHub.has(c.id) && (merged.deleted[c.id] ?? -1) < c.updated), // new here since the sync started
      ].sort((a, b) => b.updated - a.updated);
      await save(KEYS.chats, nextIndex);
      setChats(nextIndex);
      await save(DELETED_KEY, merged.deleted);
      setChat((current) => (current && merged.deleted[current.id] !== undefined && !nextIndex.some((c) => c.id === current.id) ? null : current));
      setHub((h) => ({ ...h, connected: true, lastSync: Date.now(), syncing: false, problem: undefined }));
    } catch (e) {
      setHub((h) => ({ ...h, syncing: false, problem: (e as Error).message }));
    } finally {
      syncing.current = false;
    }
  }, [hubTarget]);

  /** Sync a moment after something changes, so several quick changes go together. */
  const scheduleSync = useCallback(() => {
    if (!hubRef.current.connected) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => { syncNow(); }, 2500);
  }, [syncNow]);

  /** Find out whether the AI is ready. `auto` is a re-check while it starts; anything else starts the count again. */
  const checkStatus = useCallback(async (auto: boolean) => {
    if (recheck.current.timer) clearTimeout(recheck.current.timer);
    recheck.current.timer = null;
    if (!auto) recheck.current.tries = 0;
    let connected = false;
    let info: HubInfo | null = null;
    const target = hubTarget();
    if (target) {
      try {
        info = await hubPing(target); // a paired ping also asks the hub to start Ollama if it isn't running
        connected = info.paired;
        setHub((h) => ({ ...h, connected, name: info!.name, problem: connected ? undefined : target.kind === 'pc' ? STALE_PC_KEY : 'Not paired. Check the code.' }));
      } catch (e) {
        setHub((h) => ({ ...h, connected: false, problem: (e as Error).message }));
      }
    }
    const active = pickEngine(connected);
    let s = await active.status(settingsRef.current.modelId);
    const usesLaptopAI = Platform.OS === 'web' || active !== localEngine;
    if (!s.ready && usesLaptopAI && (s.starting || info?.starting)) {
      s = {
        ready: false, starting: true, label: 'Starting the AI…',
        problem: Platform.OS === 'web' ? 'Starting Ollama on this laptop. This takes a few seconds.' : 'Starting the AI on your laptop. This takes a few seconds.',
      };
    }
    // While the AI starts, check again every few seconds, for up to two minutes.
    if (s.starting && recheck.current.tries < 40) {
      recheck.current.tries += 1;
      recheck.current.timer = setTimeout(() => { checkRef.current(true); }, 3000);
    } else if (s.starting) {
      s = { ready: false, label: 'Ollama', problem: 'The AI is taking a long time to start. Open the Ollama app on the laptop, then press Retry.' };
    }
    setStatus(s);
    if (connected) syncNow();
    if (s.ready && active === localEngine && localEngine.warm) localEngine.warm(settingsRef.current.modelId).catch(() => undefined);
  }, [hubTarget, pickEngine, syncNow]);
  checkRef.current = checkStatus;
  const refreshStatus = useCallback(() => checkStatus(false), [checkStatus]);

  useEffect(() => {
    (async () => {
      const s = { ...DEFAULT_SETTINGS, ...(await load<Partial<Settings>>(KEYS.settings, {})) };
      setHaptics(s.haptics);
      setSettings(s);
      settingsRef.current = s;
      setMemories(await load<Memory[]>(KEYS.memories, []));
      setNotes(await load<Note[]>(KEYS.notes, []));
      setChats(await load<ChatSummary[]>(KEYS.chats, []));
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    refreshStatus();
    let lastCheck = Date.now();
    const sub = AppState.addEventListener('change', (state) => {
      // Coming back to the app re-checks the AI, but not straight after the last check (a PC window that
      // has just opened also reports gaining focus, which used to ask everything twice).
      if (state === 'active' && Date.now() - lastCheck > 10_000) {
        lastCheck = Date.now();
        refreshStatus();
      }
    });
    return () => sub.remove();
  }, [loaded, refreshStatus]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    setHaptics(next.haptics);
    await save(KEYS.settings, next);
    if ('modelId' in patch || 'hubUrl' in patch || 'hubKey' in patch || 'useLaptop' in patch) setTimeout(() => refreshStatus(), 0);
  }, [refreshStatus]);

  // ---- Memory ----
  const saveMemories = useCallback(async (next: Memory[]) => {
    memRef.current = next;
    setMemories(next);
    await save(KEYS.memories, next);
    scheduleSync();
  }, [scheduleSync]);

  const addMemory = useCallback(async (raw: string, category: MemoryCategory = 'about') => {
    const fact = cleanFact(raw);
    if (!fact || memRef.current.some((m) => m.fact.toLowerCase() === fact.toLowerCase())) return false;
    await saveMemories([...memRef.current, { id: newId(), fact, added: today(), category }]);
    return true;
  }, [saveMemories]);

  const removeMemory = useCallback(async (id: string) => {
    await markDeleted([id]);
    await saveMemories(memRef.current.filter((m) => m.id !== id));
  }, [saveMemories, markDeleted]);

  /** Meaning vectors for the facts, worked out once each and kept on this device. */
  const memoryVectors = useCallback(async (): Promise<Record<string, number[]>> => {
    const all = memRef.current;
    const index = await load<MemoryIndex>(KEYS.memoryIndex, {});
    const missing = all.filter((m) => index[m.id]?.fact !== m.fact).slice(0, 64); // the rest follow on later messages
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const vecs = await engineRef.current.embed(batch.map((m) => m.fact), 'document').catch(() => null);
      if (!vecs) break;
      batch.forEach((m, j) => { if (vecs[j]) index[m.id] = { fact: m.fact, vec: vecs[j] }; });
    }
    const live = new Set(all.map((m) => m.id));
    const kept: MemoryIndex = {};
    for (const [id, entry] of Object.entries(index)) if (live.has(id)) kept[id] = entry;
    if (missing.length || Object.keys(kept).length !== Object.keys(index).length) await save(KEYS.memoryIndex, kept);
    return Object.fromEntries(Object.entries(kept).map(([id, e]) => [id, e.vec]));
  }, []);

  /** The facts that go in this prompt: all of them while memory is small, else the most relevant. */
  const pickMemories = useCallback(async (query: string, queryVec: number[] | null, limit: number) => {
    const all = memRef.current;
    if (all.length <= limit) return all;
    const facts = queryVec ? await memoryVectors().catch(() => ({})) : {};
    return relevantMemories(all, query, limit, queryVec ? { query: queryVec, facts } : undefined);
  }, [memoryVectors]);

  const proposeTidy = useCallback(async (): Promise<TidyChange[]> => {
    if (busyRef.current) throw new Error('Wait for the current reply to finish, then try again.');
    const all = memRef.current;
    if (all.length < 2) return [];
    // A category at a time (small models mix up facts across a long mixed list), in batches it can read at once.
    const groups: Memory[][] = [];
    for (const c of CATEGORIES) {
      const group = all.filter((m) => (m.category ?? 'about') === c.id);
      for (let i = 0; i < group.length; i += TIDY_BATCH) groups.push(group.slice(i, i + TIDY_BATCH));
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const changes: TidyChange[] = [];
      for (const group of groups.filter((g) => g.length > 1)) {
        const reply = await engineRef.current.json(tidyMessages(settingsRef.current.name, group), settingsRef.current.modelId, 1500);
        changes.push(...parseTidy(reply, group));
      }
      return changes;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const applyTidy = useCallback(async (changes: TidyChange[]) => {
    const gone = new Set(changes.flatMap((c) => c.remove));
    if (!gone.size) return;
    const kept = memRef.current.filter((m) => !gone.has(m.id));
    for (const c of changes) {
      const add = c.add;
      if (!add || kept.some((m) => m.fact.toLowerCase() === add.fact.toLowerCase())) continue;
      // A merged fact keeps the date of the newest fact it replaces, so later tidies know how recent it is.
      const dates = memRef.current.filter((m) => c.remove.includes(m.id)).map((m) => m.added).sort();
      kept.push({ id: newId(), fact: add.fact, category: add.category, added: dates[dates.length - 1] ?? today() });
    }
    await markDeleted([...gone]);
    await saveMemories(kept);
  }, [markDeleted, saveMemories]);

  // ---- Notes ----
  const indexNote = useCallback(async (note: Note, index: NoteIndex) => {
    const chunks = chunkText(`${note.title}\n\n${note.text}`);
    const vectors = await engineRef.current.embed(chunks, 'document').catch(() => null);
    index[note.id] = { updated: note.updated, chunks: chunks.map((text, i) => ({ text, vec: vectors?.[i] })) };
  }, []);

  const searchNotes = useCallback(async (query: string, vec?: number[] | null): Promise<NoteHit[]> => {
    const all = notesRef.current;
    if (!all.length) return [];
    const index = await load<NoteIndex>(KEYS.noteIndex, {});
    const queryVec = vec === undefined ? (await engineRef.current.embed([query], 'query').catch(() => null))?.[0] : vec ?? undefined;
    let changed = false;
    for (const note of all) {
      const entry = index[note.id];
      const missingVectors = queryVec && entry?.chunks.some((c) => !c.vec);
      if (!entry || entry.updated !== note.updated || missingVectors) {
        await indexNote(note, index);
        changed = true;
      }
    }
    if (changed) await save(KEYS.noteIndex, index);
    const hits: NoteHit[] = [];
    for (const note of all) {
      for (const c of index[note.id]?.chunks ?? []) {
        const score = queryVec && c.vec ? similarity(queryVec, c.vec) : keywordScore(query, c.text) * 0.8;
        if (score >= (queryVec && c.vec ? 0.55 : 0.3)) hits.push({ title: note.title, text: c.text, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 4);
  }, [indexNote]);

  const saveNotes = useCallback(async (next: Note[]) => {
    notesRef.current = next;
    setNotes(next);
    await save(KEYS.notes, next);
    scheduleSync();
  }, [scheduleSync]);

  const saveNote = useCallback(async (input: { id?: string; title: string; text: string }) => {
    const note: Note = {
      id: input.id ?? newId(),
      title: input.title.trim() || titleFrom(input.text),
      text: input.text.trim(),
      updated: Date.now(),
    };
    await saveNotes([note, ...notesRef.current.filter((n) => n.id !== note.id)]);
    const index = await load<NoteIndex>(KEYS.noteIndex, {});
    await indexNote(note, index).catch(() => undefined);
    await save(KEYS.noteIndex, index);
  }, [indexNote, saveNotes]);

  const deleteNote = useCallback(async (id: string) => {
    await markDeleted([id]);
    await saveNotes(notesRef.current.filter((n) => n.id !== id));
    const index = await load<NoteIndex>(KEYS.noteIndex, {});
    delete index[id];
    await save(KEYS.noteIndex, index);
  }, [saveNotes, markDeleted]);

  // ---- Chats ----
  const saveChat = useCallback(async (c: Chat) => {
    await save(KEYS.chat(c.id), c);
    setChats((prev) => {
      const next = [{ id: c.id, title: c.title, updated: c.updated }, ...prev.filter((p) => p.id !== c.id)];
      save(KEYS.chats, next);
      return next;
    });
    scheduleSync();
  }, [scheduleSync]);

  const openChat = useCallback(async (id: string) => {
    if (busyRef.current) return;
    const c = await load<Chat | null>(KEYS.chat(id), null);
    if (c) {
      setChat(c);
      setNoted({});
      setError(null);
    }
  }, []);

  const newChat = useCallback(() => {
    if (busyRef.current) return;
    setChat(null);
    setNoted({});
    setError(null);
  }, []);

  const deleteChat = useCallback(async (id: string) => {
    await markDeleted([id]);
    await remove(KEYS.chat(id));
    setChats((prev) => {
      const next = prev.filter((p) => p.id !== id);
      save(KEYS.chats, next);
      return next;
    });
    setChat((current) => (current?.id === id ? null : current));
    scheduleSync();
  }, [markDeleted, scheduleSync]);

  const clearChats = useCallback(async () => {
    const all = await load<ChatSummary[]>(KEYS.chats, []);
    await markDeleted(all.map((c) => c.id));
    for (const c of all) await remove(KEYS.chat(c.id));
    await save(KEYS.chats, []);
    setChats([]);
    setChat(null);
    setNoted({});
    scheduleSync();
  }, [markDeleted, scheduleSync]);

  /** Ask the model to answer `userMsg`, given the earlier messages in `base`. */
  const run = useCallback(async (base: Chat, userMsg: Message) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const answerAt = base.messages.length + 1;
    setChat({ ...base, messages: [...base.messages, userMsg, { role: 'assistant', content: '' }] });
    const active = engineRef.current;

    let answer = '';
    // Draw the growing reply at most ~15 times a second. Redrawing for every token costs battery and
    // warms the phone while the model is already working hard.
    let drawTimer: ReturnType<typeof setTimeout> | null = null;
    const draw = () => {
      drawTimer = null;
      const shown = stripThinking(answer);
      setChat((c) => {
        if (!c) return c;
        const messages = c.messages.slice();
        messages[answerAt] = { role: 'assistant', content: shown };
        return { ...c, messages };
      });
    };
    try {
      const s = settingsRef.current;
      if (userMsg.images?.length && !active.vision(s.modelId)) {
        throw new Error(active.where === 'phone'
          ? 'To read photos offline, download "Photo understanding" in Settings (Qwen3.5 4B), or connect to your laptop.'
          : "This model can't read photos.");
      }
      // One meaning vector for the question serves both the notes search and choosing memories.
      const needVec = notesRef.current.length > 0 || memRef.current.length > MEMORY_LIMIT;
      const queryVec = needVec ? (await active.embed([userMsg.content], 'query').catch(() => null))?.[0] ?? null : null;
      const hits = await searchNotes(userMsg.content, queryVec).catch(() => []);
      const recentAsks = base.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.display ?? m.content);
      const memories = await pickMemories([...recentAsks, userMsg.content].join('\n'), queryVec, base.mode === 'interview' ? 80 : MEMORY_LIMIT)
        .catch(() => memRef.current.slice(-MEMORY_LIMIT));
      const prompt = systemPrompt(s, memories, hits, active.where);
      const sys: Message = { role: 'system', content: base.mode === 'interview' ? `${prompt}

${interviewPrompt(s.name)}` : prompt };
      await active.chat([sys, ...base.messages.slice(-HISTORY), userMsg], s.modelId, (token) => {
        answer += token;
        drawTimer ??= setTimeout(draw, 66);
      }, MAX_TOKENS[s.length] ?? 1024);
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.');
      refreshStatus();
    }
    if (drawTimer) clearTimeout(drawTimer);

    answer = stripThinking(answer).trim();
    const finalChat: Chat = {
      ...base,
      updated: Date.now(),
      messages: answer ? [...base.messages, userMsg, { role: 'assistant', content: answer }] : base.messages,
    };
    setChat(finalChat.messages.length ? finalChat : null);
    if (answer) await saveChat(finalChat);
    busyRef.current = false;
    setBusy(false);

    // Learn about you after the reply (so it doesn't slow it down): from this message when it's about you
    // or is feedback, from everything in a "get to know me" chat, and from the whole conversation every few turns.
    const text = userMsg.display ?? userMsg.content;
    if (!answer || !settingsRef.current.learn) return;
    const name = settingsRef.current.name;
    const userTurns = finalChat.messages.filter((m) => m.role === 'user').length;
    const jobs: Message[][] = [];
    const recent = finalChat.messages.slice(-12);
    // "Already known" lists only the related facts, so learning stays quick with a long memory.
    if (base.mode === 'interview' || worthLearning(text)) jobs.push(learnMessages(name, relevantMemories(memRef.current, text, 40), text));
    if (userTurns > 0 && userTurns % 6 === 0) {
      const said = recent.filter((m) => m.role === 'user').map((m) => m.display ?? m.content).join('\n');
      jobs.push(conversationLearnMessages(name, relevantMemories(memRef.current, said, 40), recent));
    }
    const added: string[] = [];
    for (const job of jobs) {
      try {
        const reply = await active.json(job, settingsRef.current.modelId);
        for (const f of parseFacts(reply)) if (await addMemory(f.fact, f.category)) added.push(cleanFact(f.fact));
      } catch {
        // learning is a bonus: never bother the user if it fails
      }
    }
    if (added.length) setNoted((n) => ({ ...n, [answerAt]: added }));
  }, [searchNotes, pickMemories, saveChat, addMemory, refreshStatus]);

  const send = useCallback(async (text: string, attachments?: Attachments) => {
    const t = text.trim();
    const hasAttachments = !!attachments && (attachments.images.length > 0 || attachments.files.length > 0);
    if (busyRef.current || (!t && !hasAttachments)) return;
    const now = Date.now();
    const title = titleFrom(t || attachments?.files[0]?.name || 'Photo');
    const base = chatRef.current ?? { id: newId(), title, created: now, updated: now, messages: [] };
    await run(base, withAttachments(t, attachments));
  }, [run]);

  const regenerate = useCallback(async () => {
    const c = chatRef.current;
    if (busyRef.current || !c) return;
    const lastUser = c.messages.map((m) => m.role).lastIndexOf('user');
    if (lastUser < 0) return;
    setNoted((n) => {
      const copy = { ...n };
      delete copy[lastUser + 1];
      return copy;
    });
    await run({ ...c, messages: c.messages.slice(0, lastUser) }, c.messages[lastUser]);
  }, [run]);

  const startInterview = useCallback(async () => {
    if (busyRef.current) return;
    const now = Date.now();
    setNoted({});
    setError(null);
    await run({ id: newId(), title: 'Getting to know you', created: now, updated: now, messages: [], mode: 'interview' },
      { role: 'user', content: "Let's do the get-to-know-me chat. Ask me your first question.", display: 'Get to know me' });
  }, [run]);

  const stop = useCallback(() => engineRef.current.stop(), []);
  const clearError = useCallback(() => setError(null), []);

  // ---- Moving memory and notes by file (when the laptop isn't reachable) ----
  const exportData = useCallback(async () => {
    const s = settingsRef.current;
    const backup: Backup = {
      app: 'assistant', version: 1, exported: new Date().toISOString(),
      name: s.name, instructions: s.instructions, memories: memRef.current, notes: notesRef.current,
    };
    await exportFile(backup);
  }, []);

  const importData = useCallback(async () => {
    const text = await pickFile();
    if (text === null) return null;
    let backup: Backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error("That file isn't a backup from this app.");
    }
    if (backup?.app !== 'assistant' || !Array.isArray(backup.memories) || !Array.isArray(backup.notes)) {
      throw new Error("That file isn't a backup from this app.");
    }
    let facts = 0;
    for (const m of backup.memories) if (typeof m.fact === 'string' && (await addMemory(m.fact, m.category))) facts++;
    const byId = new Map(notesRef.current.map((n) => [n.id, n]));
    let added = 0;
    for (const n of backup.notes) {
      const mine = byId.get(n.id);
      if (!mine || mine.updated < n.updated) {
        byId.set(n.id, n);
        added++;
      }
    }
    await saveNotes([...byId.values()].sort((a, b) => b.updated - a.updated));
    if (!settingsRef.current.instructions && backup.instructions) await updateSettings({ instructions: backup.instructions });
    return `Added ${facts} ${facts === 1 ? 'fact' : 'facts'} and ${added} ${added === 1 ? 'note' : 'notes'}.`;
  }, [addMemory, saveNotes, updateSettings]);

  const value: Store = {
    loaded, settings, updateSettings, status, refreshStatus, engine, hub, syncNow, memories, addMemory, removeMemory, proposeTidy, applyTidy,
    notes, saveNote, deleteNote, chats, chat, openChat, newChat, deleteChat, clearChats, busy, error, clearError, noted,
    send, regenerate, startInterview, stop, exportData, importData,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

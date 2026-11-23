// App state: chats, memory, notes and settings, saved on this device and synced with the laptop hub.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  CATEGORIES, type ChatIndex, type LearntFact, MAX_TOKENS, MEMORY_LIMIT, type PastRecall, SAME_THING, TIDY_BATCH, type TidyChange,
  chunkText, cleanFact, conversationLearnMessages, indexChat, interviewPrompt, keywordScore, learnMessages, moreMemories, parseFacts, parseTidy, stopsQuestions,
  pastFacts, recallsPast, relevantMemories, searchPast, similarity, stripThinking, systemPrompt, tidyMessages, titleFrom, turnContext, withoutClosingQuestion, worthLearning,
} from './brain';
import { actionsSupported, mayWantAction } from './deviceActions';
import { type WebHit, needsWeb, searchWeb, webQuery } from './webSearch';
import { engine as localEngine } from './engine';
import { createOllamaEngine } from './engine/ollama';
import type { Engine, EngineStatus } from './engine/types';
import { type HubInfo, type HubTarget, STALE_PC_KEY, hubPing, hubRequest, hubSync, isLinkKey, localHub, pairWith } from './hub';
import {
  type FileList, KIWIX_FOLDER, LIBRARY_FOLDER, OLD_LIBRARY_FOLDER, type LibraryBook, type LibraryHit, type LibraryPage, OTHER_FOLDERS,
  libraryCandidates, overviewTitles, searchQuery, titleQueries,
} from './library';
import { fileLibrary, nativeLibrary } from './libraryNative';
import { KEYS, load, newId, remove, save, today } from './storage';
import { exportFile, pickFile } from './transfer';
import { setHaptics } from './ui/actions';
import { setVoiceLanguage } from './ui/voice';
import type { Backup, Chat, ChatSummary, Memory, MemoryCategory, Message, Note, NoteHit, Settings } from './types';

const DEFAULT_SETTINGS: Settings = {
  name: '', learn: true, modelId: 'qwen3.5-4b', instructions: '', length: 'balanced', appearance: 'light',
  hubUrl: '', hubKey: '', useLaptop: true, accel: 'cpu', performance: 'balanced', haptics: true, onboarded: false,
  useLibraries: true, voiceLang: '', webSearch: false, libraryMode: 'ask', libraryChoice: {}, recallChats: true,
};
const HISTORY = 20; // messages of the current chat the model sees, at most

/**
 * What keeps an open chat's prompt the same from one message to the next, so the phone and Ollama only read what's
 * new: the facts in its system message (chosen at its first message), the facts known then, what the app added to
 * each message, and where the messages the model sees start. Kept while the app runs; never saved or synced.
 */
interface ChatPrompt {
  facts: string[];
  known: Set<string>;
  added: Map<number, { for: string; text: string }>; // by message position: the message it went with, and the text
  start: number;
}
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

/** Offline libraries on this device: Kiwix libraries (phone only) and your own files. */
export interface LibraryState {
  supported: boolean;
  access: boolean;                            // phone: "All files access" is on (always true on the PC)
  books: LibraryBook[];                       // Kiwix libraries and your own files in the library folder(s)
  elsewhere: LibraryBook[];                   // .zim files in Kiwix's folder, Download or Documents
  folder: string;                             // where to put them
  skipped: number;                            // your own files left out because there were too many
  reading: boolean;                           // your own files are being read
  problem?: string;                           // your own files couldn't be read at all, and why
  lostAccess: boolean;                        // phone: libraries were readable before, but "All files access" is now off
}

interface Store {
  loaded: boolean;
  startView: string;   // the screen that was open last time (Shell starts there)
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
  pinChat(id: string, pinned: boolean): Promise<void>;
  /** Archive or bring back one chat, several, or all of them (handy before a demo). */
  archiveChats(ids: string[] | 'all', archived: boolean): Promise<void>;
  clearChats(): Promise<void>;
  busy: boolean;
  error: string | null;
  clearError(): void;
  noted: Record<number, Learnt[]>; // facts learnt, by message position in the current chat
  undoLearnt(at: number, item: Learnt): Promise<void>; // forget a fact just learnt (and bring back the one it replaced)
  found: Record<number, LibraryHit[]>; // library passages offered after a reply ("Ask first"), by message position
  answerFromLibrary(at: number): Promise<void>; // answer the last message again, using what the library found
  dismissFound(at: number): void;
  setLibraryChoice(book: string, choice: 'always' | 'never' | null): Promise<void>;
  send(text: string, attachments?: Attachments, web?: boolean): Promise<void>;
  regenerate(): Promise<void>;
  startInterview(): Promise<void>; // a "get to know me" chat
  stop(): void;
  exportData(): Promise<void>;
  importData(): Promise<string | null>; // a summary of what was added, or null if cancelled
  libraries: LibraryState;
  refreshLibraries(): Promise<void>;
  allowLibraries(): Promise<void>;          // opens Android's "All files access" page
  moveLibraries(): Promise<string>;         // moves .zim files found elsewhere into Aislet; returns a summary
  removeLibrary(path: string): Promise<void>;
  openLibraryFolder: (() => Promise<void>) | null; // the PC shows the folder; null on a phone
  snapshot(): Backup;                    // memory, notes, name and instructions, for a backup
  restore(backup: Backup): Promise<string>; // adds anything new from a backup; returns a summary
}

/** A fact learnt from a message, shown under the reply with Undo. */
export interface Learnt {
  id: string;       // the new fact
  fact: string;
  was?: Memory;     // the fact it replaced
  history?: string; // the id of the "used to be true" copy of `was`
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
  const [startView, setStartView] = useState('chat');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noted, setNoted] = useState<Record<number, Learnt[]>>({});
  const [found, setFound] = useState<Record<number, LibraryHit[]>>({});
  const foundRef = useRef(found);
  foundRef.current = found;
  const prompts = useRef(new Map<string, ChatPrompt>()); // by chat id, the most recent few
  const [hub, setHub] = useState<HubState>({ connected: false, syncing: false });

  // Latest values for use inside long-running async work.
  const memRef = useRef(memories);
  memRef.current = memories;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const notesRef = useRef(notes);
  const [libraries, setLibraries] = useState<LibraryState>({
    supported: !!fileLibrary, access: !nativeLibrary, books: [], elsewhere: [], folder: '', skipped: 0, reading: false, lostAccess: false,
  });
  const readingFiles = useRef(false);
  const librariesRef = useRef(libraries);
  librariesRef.current = libraries;
  notesRef.current = notes;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const busyRef = useRef(false);
  const hubRef = useRef(hub);
  hubRef.current = hub;
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  const recheck = useRef<{ timer: ReturnType<typeof setTimeout> | null; tries: number }>({ timer: null, tries: 0 });
  const checkRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);

  // ---- Which engine answers ----
  const remote = useMemo(
    () => (Platform.OS !== 'web' && settings.hubUrl && isLinkKey(settings.hubKey)
      ? createOllamaEngine({
        send: (method, path, body, signal) => hubRequest({ base: settings.hubUrl, key: settings.hubKey, kind: 'phone' }, method, path, body, signal),
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
    return s.hubUrl && isLinkKey(s.hubKey) ? { base: s.hubUrl, key: s.hubKey, kind: 'phone' } : null;
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
        ...merged.chats.map((c) => {
          const have = mine.get(c.id);
          const kept = have && c.updated <= have.updated ? have : c; // flags come from the copy that was kept
          return { id: c.id, title: c.title, updated: Math.max(c.updated, have?.updated ?? 0), pinned: kept.pinned || undefined, archived: kept.archived || undefined };
        }),
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
  /** The system message a new chat starts with on the phone: the same for every chat until settings or memories change. */
  const newChatSystem = useCallback((where: 'phone' | 'laptop') => systemPrompt(
    settingsRef.current, relevantMemories(memRef.current.filter((m) => !m.until), '', MEMORY_LIMIT), where, actionsSupported,
  ), []);

  const checkStatus = useCallback(async (auto: boolean) => {
    if (recheck.current.timer) clearTimeout(recheck.current.timer);
    recheck.current.timer = null;
    if (!auto) recheck.current.tries = 0;
    let connected = false;
    let info: HubInfo | null = null;
    const paired = settingsRef.current;
    if (Platform.OS !== 'web' && paired.hubUrl && paired.hubKey && !isLinkKey(paired.hubKey)) {
      // Paired before the private link: turn the kept code into the link key once, when the laptop accepts it.
      try {
        const { key } = await pairWith(paired.hubUrl, paired.hubKey);
        const next = { ...settingsRef.current, hubKey: key };
        settingsRef.current = next;
        setSettings(next);
        await save(KEYS.settings, next);
        setTimeout(() => { checkRef.current(false); }, 0); // again, with the laptop's AI
        return;
      } catch (e) {
        setHub((h) => ({ ...h, connected: false, problem: (e as Error).message }));
      }
    }
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
    if (s.ready && active === localEngine && localEngine.warm) {
      // Read a new chat's system message ahead only while no chat is open: mid-chat it would replace that chat's reading.
      const idle = !chatRef.current?.messages.length;
      localEngine.warm(settingsRef.current.modelId, idle ? newChatSystem('phone') : undefined).catch(() => undefined);
    }
  }, [hubTarget, pickEngine, syncNow]);
  checkRef.current = checkStatus;
  const refreshStatus = useCallback(() => checkStatus(false), [checkStatus]);

  useEffect(() => {
    (async () => {
      const s = { ...DEFAULT_SETTINGS, ...(await load<Partial<Settings>>(KEYS.settings, {})) };
      setHaptics(s.haptics);
      setVoiceLanguage(s.voiceLang);
      setSettings(s);
      settingsRef.current = s;
      setMemories(await load<Memory[]>(KEYS.memories, []));
      setNotes(await load<Note[]>(KEYS.notes, []));
      const summaries = await load<ChatSummary[]>(KEYS.chats, []);
      setChats(summaries);
      // Come back to the chat and screen you left, even when Android closed the app in the background.
      const lastId = await load<string>(KEYS.lastChat, '');
      if (lastId && summaries.some((c) => c.id === lastId)) {
        const last = await load<Chat | null>(KEYS.chat(lastId), null);
        if (last) setChat(last);
      }
      setStartView(await load<string>(KEYS.lastView, 'chat'));
      setLoaded(true);
    })();
  }, []);

  // ---- Offline libraries: Kiwix .zim files (phone) and your own files (phone and PC) ----

  /** Kiwix libraries on this phone: in Aislet's folders, and elsewhere (to offer moving them in). */
  const kiwixBooks = useCallback(async (): Promise<{ books: LibraryBook[]; elsewhere: LibraryBook[] }> => {
    if (!nativeLibrary) return { books: [], elsewhere: [] };
    const lib = nativeLibrary;
    const root = lib.storage();
    const folder = `${root}/${LIBRARY_FOLDER}`;
    const oldFolder = `${root}/${OLD_LIBRARY_FOLDER}`;
    const info = async (path: string) => {
      const book = await lib.info(path).catch(() => null);
      return book ? { ...book, format: 'zim' } : null;
    };
    // The app's own folder needs no permission (the phone tests put a made-up library there).
    const own = await lib.find([folder, oldFolder, lib.appFolder()].filter(Boolean)).catch(() => []);
    const books = (await Promise.all(own.map((f) => info(f.path)))).filter((b): b is LibraryBook => !!b);
    const found = lib.hasAccess() ? await lib.find([KIWIX_FOLDER, ...OTHER_FOLDERS].map((d) => `${root}/${d}`)).catch(() => []) : [];
    const outside = found.filter((f) => !f.path.startsWith(`${folder}/`) && !f.path.startsWith(`${oldFolder}/`));
    const elsewhere = (await Promise.all(outside.map((f) => info(f.path)))).filter((b): b is LibraryBook => !!b);
    return { books, elsewhere };
  }, []);

  const refreshLibraries = useCallback(async () => {
    if (!fileLibrary) return;
    const files = fileLibrary;
    const access = nativeLibrary ? nativeLibrary.hasAccess() : true;
    if (nativeLibrary && access) nativeLibrary.makeFolder(`${nativeLibrary.storage()}/${LIBRARY_FOLDER}`); // so people can find it
    const kiwix = await kiwixBooks();
    // Android can switch "All files access" off (people have found it off after an update). Libraries then
    // just stop being searched, so remember that they worked here and say so if they no longer can.
    const seen = await load<boolean>(KEYS.librariesSeen, false);
    const lostAccess = !access && seen;
    const show = (list: FileList | null, reading: boolean, problem?: string) => setLibraries({
      supported: true, access, elsewhere: kiwix.elsewhere, reading, problem, lostAccess,
      books: [...kiwix.books, ...(list?.books ?? [])].sort((a, b) => a.title.localeCompare(b.title)),
      folder: list?.folder ?? '', skipped: list?.skipped ?? 0,
    });
    let list: FileList | null = null;
    try {
      list = await files.books();
    } catch (e) {
      return show(null, false, (e as Error).message);
    }
    if (access && !seen && list.books.length + kiwix.books.length > 0) save(KEYS.librariesSeen, true).catch(() => undefined);
    // New or changed files are read in the background, one pass at a time; the list shows them meanwhile.
    const toRead = settingsRef.current.useLibraries && list.books.some((b) => b.pending);
    if (!toRead || readingFiles.current) return show(list, readingFiles.current);
    show(list, true);
    readingFiles.current = true;
    try {
      show(await files.index(), false);
    } catch (e) {
      show(list, false, (e as Error).message);
    } finally {
      readingFiles.current = false;
    }
  }, [kiwixBooks]);

  const allowLibraries = useCallback(async () => {
    await nativeLibrary?.requestAccess(); // the page opens; the list refreshes when the app comes back
  }, []);

  const moveLibraries = useCallback(async () => {
    const { elsewhere, folder } = librariesRef.current;
    if (!nativeLibrary || !elsewhere.length) return 'Nothing to move.';
    let moved = 0;
    const problems: string[] = [];
    for (const f of elsewhere) {
      try {
        await nativeLibrary.move(f.path, folder);
        moved++;
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    await refreshLibraries();
    if (problems.length) throw new Error(`Moved ${moved} of ${elsewhere.length}. ${problems[0]}`);
    return `Moved ${moved} ${moved === 1 ? 'library' : 'libraries'} into Aislet.`;
  }, [refreshLibraries]);

  const removeLibrary = useCallback(async (path: string) => {
    await nativeLibrary?.remove(path);
    await refreshLibraries();
  }, [refreshLibraries]);

  /** How a library's matches are used: straight away ('always'), offered after the reply ('ask'), or not at all. */
  const libraryUse = (book: string): 'always' | 'ask' | 'never' => {
    const s = settingsRef.current;
    return s.libraryChoice?.[book] ?? (s.libraryMode === 'auto' ? 'always' : 'ask');
  };

  /**
   * Passages from this device's libraries (Kiwix and your own files) that may help answer `question`, from the
   * libraries used that way: 'always' before the reply, 'ask' after it (so it doesn't delay the first word).
   */
  const searchLibraries = useCallback(async (question: string, vec: number[] | null, use: 'always' | 'ask'): Promise<LibraryHit[]> => {
    const books = librariesRef.current.books.filter((b) => b.searchable && !b.problem && libraryUse(b.title) === use);
    if (!settingsRef.current.useLibraries || !books.length) return [];
    const query = searchQuery(question);
    if (!query) return [];
    const kiwix = async (): Promise<LibraryPage[]> => {
      const lib = nativeLibrary;
      const paths = books.filter((b) => b.format === 'zim').map((b) => b.path);
      if (!lib || !paths.length) return [];
      // Overview articles found by title ("Compost") go first, then what the full-text search found.
      const titled = overviewTitles(query, await lib.titles(paths, titleQueries(query), 3).catch(() => []));
      const overviews = await Promise.all(titled.map(async (t) => ({ ...t, rank: 0, html: await lib.read(t.book, t.path, 60000).catch(() => '') })));
      return [...overviews, ...(await lib.search(paths, query, 5, 60000).catch(() => []))];
    };
    // Your own files are searched together, so keep only the ones used this way.
    const mine = new Set(books.filter((b) => b.format !== 'zim').map((b) => b.title));
    const own = async (): Promise<LibraryPage[]> =>
      fileLibrary && mine.size
        ? (await fileLibrary.search(query, mine.size === librariesRef.current.books.filter((b) => b.format !== 'zim').length ? 6 : 12)
          .catch(() => [])).filter((p) => mine.has(p.bookTitle)).slice(0, 6)
        : [];
    const [kiwixPages, ownPages] = await Promise.all([kiwix(), own()]);
    const candidates = libraryCandidates(question, [...kiwixPages, ...ownPages], 4);
    if (!candidates.length) return [];
    // Judge by meaning when an embedding model is available, otherwise by sharing most of the question's words.
    const vectors = vec ? await engineRef.current.embed(candidates.map((c) => `${c.title}\n${c.text}`), 'document').catch(() => null) : null;
    const scored = vectors && vec
      ? candidates.map((c, i) => ({ ...c, score: similarity(vec, vectors[i]) })).filter((c) => c.score >= 0.55)
      : candidates.filter((c) => (c.match ?? 0) >= 0.6);
    return scored.sort((a, b) => b.score - a.score).slice(0, 3);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    refreshStatus();
    refreshLibraries();
    let lastCheck = Date.now();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      refreshLibraries(); // e.g. back from granting "All files access"
      // Re-check the AI too, but not straight after the last check (a PC window that has just opened also
      // reports gaining focus, which used to ask everything twice).
      if (Date.now() - lastCheck > 10_000) {
        lastCheck = Date.now();
        refreshStatus();
      }
    });
    return () => sub.remove();
  }, [loaded, refreshStatus, refreshLibraries]);

  useEffect(() => {
    if (loaded) save(KEYS.lastChat, chat?.id ?? '').catch(() => undefined);
  }, [loaded, chat?.id]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    setHaptics(next.haptics);
    setVoiceLanguage(next.voiceLang);
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
    if (!fact || memRef.current.some((m) => !m.until && m.fact.toLowerCase() === fact.toLowerCase())) return false;
    await saveMemories([...memRef.current, { id: newId(), fact, added: today(), category }]);
    return true;
  }, [saveMemories]);

  /**
   * Save a fact the model picked out. When it updates a known fact (a new job, a move), the old one is kept as
   * history ("used to be true"), except for preferences, where only the newest matters.
   */
  const learnFact = useCallback(async (f: LearntFact): Promise<Learnt | null> => {
    const fact = cleanFact(f.fact);
    if (!fact || memRef.current.some((m) => !m.until && m.fact.toLowerCase() === fact.toLowerCase())) return null;
    let old = f.replaces;
    if (!old && f.maybe) {
      const vecs = await engineRef.current.embed([f.maybe.fact, fact], 'document').catch(() => null);
      if (vecs?.[0] && vecs[1] && similarity(vecs[0], vecs[1]) >= SAME_THING) old = f.maybe;
    }
    // An update stays where the fact it replaces was filed, so Memory doesn't move it between groups.
    const item: Memory = { id: newId(), fact, added: today(), category: old?.category ?? f.category };
    if (!old || !memRef.current.some((m) => m.id === old.id)) {
      await saveMemories([...memRef.current, item]);
      return { id: item.id, fact };
    }
    // A new id for the history copy: the hub keeps the first copy of an id it sees, so an edit in place wouldn't sync.
    const history: Memory | null = item.category === 'preferences' ? null : { ...old, id: newId(), until: today() };
    await markDeleted([old.id]);
    await saveMemories([...memRef.current.filter((m) => m.id !== old.id), ...(history ? [history] : []), item]);
    return { id: item.id, fact, was: old, history: history?.id };
  }, [saveMemories, markDeleted]);

  const undoLearnt = useCallback(async (at: number, item: Learnt) => {
    const gone = [item.id, ...(item.history ? [item.history] : [])];
    await markDeleted(gone);
    const kept = memRef.current.filter((m) => !gone.includes(m.id));
    // The replaced fact comes back as it was (with a new id: the old one is marked deleted for sync).
    await saveMemories(item.was ? [...kept, { ...item.was, id: newId() }] : kept);
    setNoted((n) => ({ ...n, [at]: (n[at] ?? []).filter((l) => l.id !== item.id) }));
  }, [saveMemories, markDeleted]);

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
    const all = memRef.current.filter((m) => !m.until);
    if (all.length <= limit) return all;
    const facts = queryVec ? await memoryVectors().catch(() => ({})) : {};
    return relevantMemories(all, query, limit, queryVec ? { query: queryVec, facts } : undefined);
  }, [memoryVectors]);

  const proposeTidy = useCallback(async (): Promise<TidyChange[]> => {
    if (busyRef.current) throw new Error('Wait for the current reply to finish, then try again.');
    const all = memRef.current.filter((m) => !m.until); // what used to be true is history, not something to tidy
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
      const next = [{ id: c.id, title: c.title, updated: c.updated, pinned: c.pinned, archived: c.archived }, ...prev.filter((p) => p.id !== c.id)];
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
      setFound({});
      setError(null);
    }
  }, []);

  const newChat = useCallback(() => {
    if (busyRef.current) return;
    setChat(null);
    setNoted({});
    setFound({});
    setError(null);
  }, []);

  /**
   * The searchable text of earlier chats, brought up to date: only chats saved or synced since the last look are
   * read again, so this costs nothing per message and little when a question looks back.
   */
  const chatIndex = useCallback(async (): Promise<ChatIndex> => {
    const index = await load<ChatIndex>(KEYS.chatIndex, {});
    const list = (await load<ChatSummary[]>(KEYS.chats, [])).filter((c) => !c.archived); // archived chats aren't looked back on
    const live = new Set(list.map((c) => c.id));
    let changed = false;
    for (const id of Object.keys(index)) {
      if (!live.has(id)) {
        delete index[id];
        changed = true;
      }
    }
    for (const c of list) {
      if (index[c.id]?.updated === c.updated) continue;
      const full = await load<Chat | null>(KEYS.chat(c.id), null);
      if (full) index[c.id] = indexChat(full, settingsRef.current.name);
      changed = true;
    }
    if (changed) await save(KEYS.chatIndex, index);
    return index;
  }, []);

  /** What earlier chats (and facts that used to be true) say about a question that looks back. */
  const recallPast = useCallback(async (question: string, exclude: string, vec: number[] | null): Promise<PastRecall> => {
    let items = searchPast(await chatIndex(), question, exclude, 8);
    if (vec && items.length > 1 && items[0].score > 0) {
      // Words found the candidates; meaning puts the best first.
      const vecs = await engineRef.current.embed(items.map((i) => i.text), 'document').catch(() => null);
      if (vecs) items = items.map((it, i) => ({ ...it, score: 0.3 * it.score + (vecs[i] ? similarity(vec, vecs[i]) : 0) })).sort((a, b) => b.score - a.score);
    }
    return { items: items.slice(0, 3), history: pastFacts(memRef.current, question) };
  }, [chatIndex]);

  /** Deleted chats leave the index straight away, not at the next search. */
  const unindex = useCallback(async (ids: string[] | 'all') => {
    if (ids === 'all') return remove(KEYS.chatIndex);
    const index = await load<ChatIndex>(KEYS.chatIndex, {});
    if (!ids.some((id) => id in index)) return;
    for (const id of ids) delete index[id];
    await save(KEYS.chatIndex, index);
  }, []);

  const deleteChat = useCallback(async (id: string) => {
    await markDeleted([id]);
    await remove(KEYS.chat(id));
    await unindex([id]).catch(() => undefined);
    setChats((prev) => {
      const next = prev.filter((p) => p.id !== id);
      save(KEYS.chats, next);
      return next;
    });
    setChat((current) => (current?.id === id ? null : current));
    scheduleSync();
  }, [markDeleted, scheduleSync, unindex]);

  const pinChat = useCallback(async (id: string, pinned: boolean) => {
    const c = await load<Chat | null>(KEYS.chat(id), null);
    if (!c || !!c.pinned === pinned) return;
    // One millisecond newer: enough for sync to carry the pin, never enough to win over newer messages
    // written on the other device. The chat keeps its place in the list by date.
    const next: Chat = { ...c, updated: c.updated + 1 };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    await save(KEYS.chat(id), next);
    setChats((prev) => {
      const list = prev.map((p) => (p.id === id ? { ...p, updated: next.updated, pinned: next.pinned } : p));
      save(KEYS.chats, list);
      return list;
    });
    setChat((current) => (current?.id === id ? { ...current, pinned: next.pinned } : current));
    scheduleSync();
  }, [scheduleSync]);

  const archiveChats = useCallback(async (ids: string[] | 'all', archived: boolean) => {
    const list = await load<ChatSummary[]>(KEYS.chats, []);
    const wanted = ids === 'all' ? null : new Set(ids);
    const changed = new Map<string, number>(); // id → new updated
    for (const s of list) {
      if ((wanted && !wanted.has(s.id)) || !!s.archived === archived) continue;
      const c = await load<Chat | null>(KEYS.chat(s.id), null);
      if (!c) continue;
      // One millisecond newer, as with pins: sync carries it without beating newer messages from the other device.
      const next: Chat = { ...c, updated: c.updated + 1 };
      if (archived) next.archived = true;
      else delete next.archived;
      await save(KEYS.chat(s.id), next);
      changed.set(s.id, next.updated);
    }
    if (!changed.size) return;
    setChats((prev) => {
      const next = prev.map((p) => {
        const updated = changed.get(p.id);
        if (updated === undefined) return p;
        const { archived: _, ...rest } = p;
        return archived ? { ...rest, updated, archived: true } : { ...rest, updated };
      });
      save(KEYS.chats, next);
      return next;
    });
    setChat((current) => (current && changed.has(current.id) ? { ...current, archived: archived || undefined } : current));
    scheduleSync();
  }, [scheduleSync]);

  const clearChats = useCallback(async () => {
    const all = await load<ChatSummary[]>(KEYS.chats, []);
    await markDeleted(all.map((c) => c.id));
    for (const c of all) await remove(KEYS.chat(c.id));
    await unindex('all').catch(() => undefined);
    await save(KEYS.chats, []);
    setChats([]);
    setChat(null);
    setNoted({});
    setFound({});
    scheduleSync();
  }, [markDeleted, scheduleSync, unindex]);

  /** Ask the model to answer `userMsg`, given the earlier messages in `base`. */
  const run = useCallback(async (base: Chat, userMsg: Message, opts?: { library?: LibraryHit[] }) => {
    // Asked to stop a "get to know me" chat: from this message on it's an ordinary chat.
    const stopping = base.mode === 'interview' && stopsQuestions(userMsg.display ?? userMsg.content);
    if (stopping) base = { ...base, mode: undefined };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const answerAt = base.messages.length + 1;
    setChat({ ...base, messages: [...base.messages, userMsg, { role: 'assistant', content: '' }] });
    const active = engineRef.current;

    let answer = '';
    let searched: Message['searched'];
    let queryVec: number[] | null = null;
    // While it searches the web, and after, the reply says so.
    const setReplyNote = (note: Message['searched']) => setChat((c) => {
      if (!c) return c;
      const messages = c.messages.slice();
      messages[answerAt] = { ...messages[answerAt], role: 'assistant', searched: note };
      return { ...c, messages };
    });
    // Draw the growing reply at most ~15 times a second. Redrawing for every token costs battery and
    // warms the phone while the model is already working hard.
    let drawTimer: ReturnType<typeof setTimeout> | null = null;
    const draw = () => {
      drawTimer = null;
      const shown = stripThinking(answer);
      setChat((c) => {
        if (!c) return c;
        const messages = c.messages.slice();
        messages[answerAt] = { role: 'assistant', content: shown, searched };
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
      const asked = (userMsg.display ?? userMsg.content).trim();
      // Earlier chats are searched only when the question looks back ("what did we say about…").
      const recall = s.recallChats !== false && base.mode !== 'interview' && recallsPast(asked);
      // One meaning vector for the question serves the notes search, choosing memories, libraries and earlier chats.
      const needVec = notesRef.current.length > 0 || memRef.current.length > MEMORY_LIMIT || librariesRef.current.books.length > 0 || recall;
      queryVec = needVec ? (await active.embed([userMsg.content], 'query').catch(() => null))?.[0] ?? null : null;
      const hits = await searchNotes(userMsg.content, queryVec).catch(() => []);
      const library = opts?.library ?? await searchLibraries(asked, queryVec, 'always').catch(() => []);
      const past = recall ? await recallPast(asked, base.id, queryVec).catch(() => ({ items: [], history: [] })) : null;
      const recentAsks = base.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.display ?? m.content);
      const query = [...recentAsks, userMsg.content].join('\n');
      // The facts in the system message are chosen at the chat's first message and then kept, so the system message
      // stays the same. Facts learnt since, or left out but matching this message, go with this message instead.
      const current = memRef.current.filter((m) => !m.until);
      let ps = prompts.current.get(base.id);
      if (!ps) {
        const limit = base.mode === 'interview' ? 80 : MEMORY_LIMIT;
        // On the phone the facts don't depend on the first message, so every new chat has the same system message
        // and reuses the phone's reading of it (see newChatSystem). Facts that match a message still go with it.
        const chosen = active.where === 'phone' && base.mode !== 'interview'
          ? relevantMemories(current, '', limit)
          : await pickMemories(query, queryVec, limit).catch(() => current.slice(-limit));
        ps = { facts: chosen.map((m) => m.id), known: new Set(current.map((m) => m.id)), added: new Map(), start: 0 };
        prompts.current.set(base.id, ps);
        if (prompts.current.size > 8) prompts.current.delete(prompts.current.keys().next().value!);
      }
      const inSystem = new Set(ps.facts);
      const memories = current.filter((m) => inSystem.has(m.id)); // a fact forgotten since drops out (the system message changes once)
      const rest = current.filter((m) => !inSystem.has(m.id));
      const fresh = new Set(rest.filter((m) => !ps.known.has(m.id)).map((m) => m.id));
      const facts = rest.length && queryVec ? await memoryVectors().catch(() => ({})) : null;
      const extra = base.mode === 'interview' ? rest.filter((m) => fresh.has(m.id))
        : moreMemories(rest, query, fresh, queryVec && facts ? { query: queryVec, facts } : undefined);
      const actions = actionsSupported && mayWantAction(userMsg.display ?? userMsg.content, recentAsks);
      // Search the web: when asked with the globe, or when the question needs current information. Not in a
      // get-to-know-me chat, and not by itself for a message about an attached photo or file.
      let web: { query: string; hits: WebHit[] } | null = null;
      if (s.webSearch && base.mode !== 'interview' && asked
        && (userMsg.web || (!userMsg.images?.length && !userMsg.files?.length && needsWeb(asked)))) {
        const query = webQuery(asked);
        setReplyNote({ query, ok: true });
        const hits = await searchWeb(query).catch(() => []);
        // A phone reads about 35 words a second: the top three results, a little shorter, are plenty to answer from.
        web = { query, hits: active.where === 'phone' ? hits.slice(0, 3).map((h) => ({ ...h, snippet: h.snippet.slice(0, 300) })) : hits };
        searched = { query, ok: web.hits.length > 0, sources: web.hits.map((h) => ({ title: h.title, url: h.url })) };
        setReplyNote(searched);
      }
      const prompt = systemPrompt(s, memories, active.where, actionsSupported);
      const sys: Message = { role: 'system', content: base.mode === 'interview' ? `${prompt}

${interviewPrompt(s.name)}` : prompt };
      // What the app found for this message (a look back, notes, libraries, the web, facts, how to set alarms) goes
      // with it, never in the chat that's saved. It's kept with the message while the chat stays open, so later
      // prompts begin exactly as this one did and only what's new is read.
      const added = turnContext(s.name, { past, notes: hits, library, web, actions, memories: extra, stopQuestions: stopping });
      const at = base.messages.length;
      for (const k of [...ps.added.keys()]) if (k >= at) ps.added.delete(k); // answered again: those messages are gone
      if (added) ps.added.set(at, { for: userMsg.content, text: added });
      // The window of messages moves on in steps, not one message at a time, so most prompts only add to the last.
      const cp = ps;
      if (at - cp.start > HISTORY) {
        cp.start = at - HISTORY / 2;
        while (cp.start < at && base.messages[cp.start].role !== 'user') cp.start++;
      }
      // Kept additions must leave room in the model's context (8192 tokens): past about 3,500 tokens of them, the
      // older ones go (the prompt is read afresh once).
      let size = 0;
      for (const [k, a] of cp.added) if (k >= cp.start) size += a.text.length;
      for (const k of [...cp.added.keys()]) if (k < cp.start || (size > 12_000 && k < at)) cp.added.delete(k);
      const withAdded = (m: Message, i: number): Message => {
        const a = cp.added.get(i);
        return a && a.for === m.content ? { ...m, content: `${a.text}\n\n${m.content}` } : m;
      };
      const history = base.messages.slice(cp.start).map((m, i) => withAdded(m, cp.start + i));
      await active.chat([sys, ...history, withAdded(userMsg, at)], s.modelId, (token) => {
        answer += token;
        drawTimer ??= setTimeout(draw, 66);
      }, MAX_TOKENS[s.length] ?? 1024);
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.');
      refreshStatus();
    }
    if (drawTimer) clearTimeout(drawTimer);

    answer = stripThinking(answer).trim();
    if (stopping && answer) answer = withoutClosingQuestion(answer);
    const finalChat: Chat = {
      ...base,
      pinned: chatsRef.current.find((c) => c.id === base.id)?.pinned, // pinned or unpinned while it answered
      archived: chatsRef.current.find((c) => c.id === base.id)?.archived, // likewise archived
      updated: Date.now(),
      messages: answer ? [...base.messages, userMsg, { role: 'assistant', content: answer, searched }] : base.messages,
    };
    setChat(finalChat.messages.length ? finalChat : null);
    if (answer) await saveChat(finalChat);
    busyRef.current = false;
    setBusy(false);
    const text = userMsg.display ?? userMsg.content;
    if (!answer) return;

    // "Ask first" libraries are searched after the reply, so they never delay it; a match is offered under it.
    if (!opts?.library && base.mode !== 'interview') {
      const offer = await searchLibraries(text, queryVec, 'ask').catch(() => []);
      if (offer.length) setFound((f) => ({ ...f, [answerAt]: offer }));
    }

    // Learn about you after the reply (so it doesn't slow it down): from this message when it's about you
    // or is feedback, from everything in a "get to know me" chat, and from the whole conversation every few turns.
    if (!settingsRef.current.learn) return;
    const name = settingsRef.current.name;
    const userTurns = finalChat.messages.filter((m) => m.role === 'user').length;
    const jobs: { messages: Message[]; known: Memory[] }[] = [];
    const recent = finalChat.messages.slice(-12);
    // Feedback ("too long") is about the reply before this message: the model sees its start, to know what it means.
    const before = base.messages[base.messages.length - 1];
    const reactingTo = before?.role === 'assistant' ? before.content : '';
    // "Already known" lists only the related facts, so learning stays quick with a long memory.
    if (base.mode === 'interview' || worthLearning(text)) {
      const known = relevantMemories(memRef.current, text, active.where === 'phone' ? 15 : 40); // fewer to read on a phone
      jobs.push({ messages: learnMessages(name, known, text, reactingTo), known });
    }
    if (userTurns > 0 && userTurns % 6 === 0) {
      const said = recent.filter((m) => m.role === 'user').map((m) => m.display ?? m.content).join('\n');
      const known = relevantMemories(memRef.current, said, active.where === 'phone' ? 15 : 40);
      jobs.push({ messages: conversationLearnMessages(name, known, recent), known });
    }
    const added: Learnt[] = [];
    for (const job of jobs) {
      try {
        const reply = await active.json(job.messages, settingsRef.current.modelId);
        for (const f of parseFacts(reply, job.known, name)) {
          const item = await learnFact(f);
          if (item) added.push(item);
        }
      } catch {
        // learning is a bonus: never bother the user if it fails
      }
    }
    if (added.length) setNoted((n) => ({ ...n, [answerAt]: added }));
  }, [searchNotes, searchLibraries, recallPast, pickMemories, memoryVectors, saveChat, learnFact, refreshStatus]);

  /** Answer the reply at `at` again, using the library passages offered under it. */
  const answerFromLibrary = useCallback(async (at: number) => {
    const c = chatRef.current;
    const hits = foundRef.current[at];
    if (busyRef.current || !c || !hits?.length || c.messages[at - 1]?.role !== 'user') return;
    setFound((f) => {
      const copy = { ...f };
      delete copy[at];
      return copy;
    });
    setNoted((n) => {
      const copy = { ...n };
      delete copy[at];
      return copy;
    });
    await run({ ...c, messages: c.messages.slice(0, at - 1) }, c.messages[at - 1], { library: hits });
  }, [run]);

  const dismissFound = useCallback((at: number) => {
    setFound((f) => {
      const copy = { ...f };
      delete copy[at];
      return copy;
    });
  }, []);

  const setLibraryChoice = useCallback(async (book: string, choice: 'always' | 'never' | null) => {
    const next = { ...(settingsRef.current.libraryChoice ?? {}) };
    if (choice) next[book] = choice;
    else delete next[book];
    await updateSettings({ libraryChoice: next });
  }, [updateSettings]);

  const send = useCallback(async (text: string, attachments?: Attachments, web?: boolean) => {
    const t = text.trim();
    const hasAttachments = !!attachments && (attachments.images.length > 0 || attachments.files.length > 0);
    if (busyRef.current || (!t && !hasAttachments)) return;
    const now = Date.now();
    const title = titleFrom(t || attachments?.files[0]?.name || 'Photo');
    const base = chatRef.current ?? { id: newId(), title, created: now, updated: now, messages: [] };
    const message = withAttachments(t, attachments);
    await run(base, web ? { ...message, web: true } : message);
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
    dismissFound(lastUser + 1);
    await run({ ...c, messages: c.messages.slice(0, lastUser) }, c.messages[lastUser]);
  }, [run, dismissFound]);

  const startInterview = useCallback(async () => {
    if (busyRef.current) return;
    const now = Date.now();
    setNoted({});
    setFound({});
    setError(null);
    await run({ id: newId(), title: 'Getting to know you', created: now, updated: now, messages: [], mode: 'interview' },
      { role: 'user', content: "Let's do the get-to-know-me chat. Ask me your first question.", display: 'Get to know me' });
  }, [run]);

  const stop = useCallback(() => engineRef.current.stop(), []);
  const clearError = useCallback(() => setError(null), []);

  // ---- Moving memory and notes by file (when the laptop isn't reachable) ----
  const snapshot = useCallback((): Backup => {
    const s = settingsRef.current;
    return {
      app: 'assistant', version: 1, exported: new Date().toISOString(),
      name: s.name, instructions: s.instructions, memories: memRef.current, notes: notesRef.current,
    };
  }, []);

  const exportData = useCallback(async () => {
    await exportFile(snapshot());
  }, [snapshot]);

  // Adds anything new from a backup (an export or an encrypted backup); nothing is overwritten.
  const restore = useCallback(async (backup: Backup) => {
    if (backup?.app !== 'assistant' || !Array.isArray(backup.memories) || !Array.isArray(backup.notes)) {
      throw new Error("That file isn't a backup from this app.");
    }
    let facts = 0;
    const history: Memory[] = [];
    for (const m of backup.memories) {
      if (typeof m.fact !== 'string') continue;
      if (typeof m.until === 'string') { // what used to be true stays history
        const fact = cleanFact(m.fact);
        const seen = [...memRef.current, ...history].some((x) => x.until && x.fact.toLowerCase() === fact.toLowerCase());
        if (fact && !seen) history.push({ id: newId(), fact, added: typeof m.added === 'string' ? m.added : today(), category: m.category, until: m.until });
      } else if (await addMemory(m.fact, m.category)) facts++;
    }
    if (history.length) await saveMemories([...memRef.current, ...history]);
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
  }, [addMemory, saveMemories, saveNotes, updateSettings]);

  const importData = useCallback(async () => {
    const text = await pickFile();
    if (text === null) return null;
    let backup: Backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error("That file isn't a backup from this app.");
    }
    return restore(backup);
  }, [restore]);

  const value: Store = {
    loaded, startView, settings, updateSettings, status, refreshStatus, engine, hub, syncNow, memories, addMemory, removeMemory, proposeTidy, applyTidy,
    notes, saveNote, deleteNote, chats, chat, openChat, newChat, deleteChat, pinChat, archiveChats, clearChats, busy, error, clearError, noted,
    undoLearnt, found, answerFromLibrary, dismissFound, setLibraryChoice,
    send, regenerate, startInterview, stop, exportData, importData, snapshot, restore,
    libraries, refreshLibraries, allowLibraries, moveLibraries, removeLibrary, openLibraryFolder: fileLibrary?.openFolder ?? null,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

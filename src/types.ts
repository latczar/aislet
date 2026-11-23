export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;            // what the model sees (may include an attached file's text)
  display?: string;           // what the chat shows, when different from content
  images?: string[];          // attached photos, base64 JPEG (kept on this device only)
  files?: { name: string }[]; // names of attached files, for the chat to show
  web?: boolean;              // you: search the web for this one (the globe by the message box)
  searched?: { query: string; ok: boolean; sources?: { title: string; url: string }[] }; // AI: it searched the web first
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: Message[];
  mode?: 'interview'; // a "get to know me" chat
  pinned?: boolean;   // shown at the top of the chat list (synced with the laptop)
  archived?: boolean; // kept, but out of the chat list, the new-chat page and look-backs until unarchived (synced)
}

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updated' | 'pinned' | 'archived'>;

export type MemoryCategory = 'about' | 'preferences' | 'goals' | 'people' | 'projects';

export interface Memory {
  id: string;
  fact: string;
  added: string; // YYYY-MM-DD
  category?: MemoryCategory;
  until?: string; // YYYY-MM-DD: no longer true from then (a newer fact replaced it); kept as history
}

export interface Note {
  id: string;
  title: string;
  text: string;
  updated: number;
}

export type AnswerLength = 'short' | 'balanced' | 'detailed';
export type Appearance = 'light' | 'dark' | 'system';
export type Accel = 'cpu' | 'gpu' | 'npu'; // phone: which chip runs the model
export type Performance = 'cool' | 'balanced' | 'max';

export interface Settings {
  name: string;
  learn: boolean;
  modelId: string;      // phone only: which downloaded model to use
  instructions: string; // how you want it to respond
  length: AnswerLength;
  appearance: Appearance;
  hubUrl: string;      // phone: the laptop hub, e.g. http://192.168.1.20:8766
  hubKey: string;      // phone: the pairing code shown on the laptop
  useLaptop: boolean;  // phone: use the laptop's bigger model when it's reachable
  accel: Accel;
  performance: Performance;
  haptics: boolean;    // phone: a light buzz on taps
  onboarded: boolean;  // finished the first-run set-up
  useLibraries: boolean; // search offline libraries (Kiwix .zim files) when answering
  libraryMode: 'ask' | 'auto'; // ask: answer first, then offer what a library found; auto: use matches straight away
  libraryChoice: Record<string, 'always' | 'never'>; // per library (by name): overrides libraryMode
  recallChats: boolean; // search earlier chats when a question looks back ("what did we say about…")
  voiceLang: string;   // phone: speech language for talking and reading aloud ('' = English)
  webSearch: boolean;  // search the web (DuckDuckGo) when a question needs current information
}

/** Everything that moves between devices with Export / Import. */
export interface Backup {
  app: 'assistant';
  version: 1;
  exported: string;
  name: string;
  instructions: string;
  memories: Memory[];
  notes: Note[];
}

export interface NoteHit {
  title: string;
  text: string;
  score: number;
}

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;            // what the model sees (may include an attached file's text)
  display?: string;           // what the chat shows, when different from content
  images?: string[];          // attached photos, base64 JPEG (kept on this device only)
  files?: { name: string }[]; // names of attached files, for the chat to show
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: Message[];
  mode?: 'interview'; // a "get to know me" chat
}

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updated'>;

export type MemoryCategory = 'about' | 'preferences' | 'goals' | 'people' | 'projects';

export interface Memory {
  id: string;
  fact: string;
  added: string; // YYYY-MM-DD
  category?: MemoryCategory;
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

import type { Accel, Message, Performance } from '../types';

export interface EngineStatus {
  ready: boolean;
  label: string;        // e.g. "Your laptop's AI"
  model?: string;       // e.g. "qwen3.5:9b", shown as detail
  problem?: string;     // plain-English reason it isn't ready
  needsModel?: boolean; // phone: no model downloaded yet
  starting?: boolean;   // the laptop's AI is starting up; check again shortly
}

export interface ModelInfo {
  id: string;
  name: string;
  note: string;
  size: number; // bytes
  url: string;
  file: string;
  downloaded: boolean;
  forModel?: string; // an add-on that only works with this chat model (photo understanding)
  legacy?: boolean; // no longer offered; listed only if it's already on the phone
}

/** Phone only: download and manage on-device models. */
export interface ModelManager {
  chatModels(): ModelInfo[];
  searchModel(): ModelInfo;
  visionModel(): ModelInfo;
  /** The chat model that suits this phone's memory. */
  recommended(): string;
  download(id: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Engine {
  where: 'laptop' | 'phone';
  status(modelId: string): Promise<EngineStatus>;
  /** Stream a reply; returns the full text. */
  chat(messages: Message[], modelId: string, onToken: (text: string) => void, maxTokens?: number): Promise<string>;
  /** A JSON-only reply, used for learning facts (short) and tidying memory (longer). */
  json(messages: Message[], modelId: string, maxTokens?: number): Promise<string>;
  /** Vectors for notes search, or null when no embedding model is available. */
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][] | null>;
  /** Whether this engine can look at photos right now. */
  vision(modelId: string): boolean;
  stop(): void;
  /** Load the model ahead of time so the first reply is quick. */
  /** Load the model; with a system message, also read it ahead (the phone), so the next new chat starts sooner. */
  warm?(modelId: string, system?: string): Promise<void>;
  /** Choose the chip (phone) and how hard to work: cool, balanced or max. */
  configure?(opts: { accel: Accel; performance: Performance }): void;
  /** Phone: speed of the last reply, in tokens per second. */
  lastSpeed?(): number | null;
  models?: ModelManager;
}

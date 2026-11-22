// Phone engine: a smaller model running on the phone itself (llama.cpp via llama.rn).
// Works with no internet once a model has been downloaded. Built to stay cool: 4 CPU threads,
// optional GPU/NPU, and the model is unloaded after a few idle minutes.
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';
import { normalise } from '../brain';
import type { Accel, Message, Performance } from '../types';
import { chatmlPrompt, chatmlSystem } from './chatml';
import { nativeLibrary } from '../libraryNative';
import type { Engine, ModelInfo, ModelManager } from './types';

type Spec = Omit<ModelInfo, 'downloaded'>; // size is the exact byte count of the pinned file

const CHAT_MODELS: Spec[] = [
  {
    id: 'qwen3.5-4b', name: 'Qwen3.5 4B', note: 'Best answers. For phones with 8 GB of memory or more.', size: 2740937888,
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf', file: 'Qwen3.5-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3.5-2b', name: 'Qwen3.5 2B', note: 'Lighter and quicker, for phones with less memory. A little less clever.', size: 2012012800,
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q8_0.gguf', file: 'Qwen3.5-2B-Q8_0.gguf',
  },
  // Offered before 1.1.2; still listed and usable for anyone who has one.
  {
    id: 'qwen3-4b', name: 'Qwen3 4B', note: 'Older model.', size: 2497280256, legacy: true,
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf', file: 'Qwen3-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-1.7b', name: 'Qwen3 1.7B', note: 'Older model.', size: 1834426016, legacy: true,
    url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf', file: 'Qwen3-1.7B-Q8_0.gguf',
  },
];

const SEARCH_MODEL: Spec = {
  id: 'nomic-embed', name: 'Notes search', note: 'Finds the right notes by meaning, not just matching words.', size: 146146432,
  url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.Q8_0.gguf',
  file: 'nomic-embed-text-v1.5.Q8_0.gguf',
};

// Lets Qwen3.5 4B understand photos.
const VISION_MODEL: Spec = {
  id: 'qwen3.5-4b-vision', name: 'Photo understanding', note: 'Lets the phone model read photos and screenshots offline.', size: 672423616,
  url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/mmproj-F16.gguf', file: 'Qwen3.5-4B-mmproj-F16.gguf',
};
const VISION_FOR = 'qwen3.5-4b';

const STOP = ['<|im_end|>', '<|endoftext|>', '<|end|>', '<|eot_id|>', '</s>'];

// How hard the phone works. The S25 has 8 fast cores (2 prime + 6 performance).
// Measured on an S25 with Qwen3.5 4B (14 Nov 2026): writing a reply is limited by memory speed, so
// 2 threads gave 13.5 tokens/s, 4 gave 16.7 and 8 only 13.6 (the cores fight over memory).
// More threads mainly help read a long prompt (notes, files) faster.
const PROFILE: Record<Performance, { threads: number; idleMs: number }> = {
  cool: { threads: 2, idleMs: 60_000 },          // gentle: a little slower, least heat
  balanced: { threads: 4, idleMs: 3 * 60_000 },  // the default, and the fastest at writing
  max: { threads: 6, idleMs: 10 * 60_000 },      // reads long prompts fastest and stays loaded longer
};

function folder(): Directory {
  const dir = new Directory(Paths.document, 'models');
  if (!dir.exists) dir.create();
  return dir;
}
const modelFile = (s: Spec) => new File(folder(), s.file);

/** Resolves when the app is on screen (straight away if it already is), or when cancelled. */
function whenInFront(signal: AbortSignal): Promise<void> {
  if (AppState.currentState === 'active' || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      sub.remove();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') done(); });
    signal.addEventListener('abort', done);
  });
}
const doneMarker = (s: Spec) => new File(folder(), `${s.file}.complete`); // written only after a full download
const isDownloaded = (s: Spec) => modelFile(s).exists && doneMarker(s).exists;
const spec = (id: string) => [...CHAT_MODELS, SEARCH_MODEL, VISION_MODEL].find((m) => m.id === id);

let accel: Accel = 'cpu';
let performance: Performance = 'balanced';
let chatCtx: LlamaContext | null = null;
let chatKey = ''; // model + accel the context was made with
let prefilling: Promise<void> | null = null; // reading the system message ahead (warm)
let asking: Promise<string> | null = null; // learning or tidying; a new message stops it
let visionOn = false;
let embedCtx: LlamaContext | null = null;
let loading: Promise<LlamaContext> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let speed: number | null = null;

async function unload() {
  const c = chatCtx;
  const e = embedCtx;
  chatCtx = null;
  embedCtx = null;
  chatKey = '';
  visionOn = false;
  await c?.release().catch(() => undefined);
  await e?.release().catch(() => undefined);
}

/** Free the phone's memory and keep it cool when the app isn't being used. */
function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { unload(); }, PROFILE[performance].idleMs);
}

function accelParams(a: Accel) {
  if (a === 'gpu') return { n_gpu_layers: 99 };
  if (a === 'npu') return { n_gpu_layers: 99, devices: ['HTP0'] };
  return { n_gpu_layers: 0 };
}

async function chatContext(modelId: string): Promise<LlamaContext> {
  const key = `${modelId}|${accel}|${performance}`;
  if (chatCtx && chatKey === key) return chatCtx;
  if (loading) await loading.catch(() => undefined);
  if (chatCtx && chatKey === key) return chatCtx;
  const s = spec(modelId);
  if (!s || !isDownloaded(s)) throw new Error('Download a model in Settings first. After that it works offline.');
  if (chatCtx) {
    await chatCtx.release().catch(() => undefined);
    chatCtx = null;
    visionOn = false;
  }
  const base = { model: modelFile(s).uri, n_ctx: 8192, n_threads: PROFILE[performance].threads, use_mlock: false, ctx_shift: false };
  loading = initLlama({ ...base, ...accelParams(accel) }).catch((e) => {
    if (accel === 'cpu') throw e;
    console.warn(`[ember] ${accel} failed (${(e as Error).message}); using CPU`);
    return initLlama({ ...base, n_gpu_layers: 0 }); // fall back to CPU rather than fail
  });
  try {
    chatCtx = await loading;
    chatKey = key;
    return chatCtx;
  } finally {
    loading = null;
  }
}

async function ensureVision(ctx: LlamaContext) {
  if (visionOn) return;
  const ok = await ctx.initMultimodal({ path: modelFile(VISION_MODEL).uri, use_gpu: accel !== 'cpu' });
  if (!ok) throw new Error("Couldn't load photo understanding. Try deleting and downloading it again in Settings.");
  visionOn = true;
}

async function embedContext(): Promise<LlamaContext | null> {
  if (embedCtx) return embedCtx;
  if (!isDownloaded(SEARCH_MODEL)) return null;
  embedCtx = await initLlama({ model: modelFile(SEARCH_MODEL).uri, embedding: true, n_ctx: 2048, n_gpu_layers: 0, n_threads: 2 });
  return embedCtx;
}

/** llama.rn's message format; only the latest photos are included, to keep it quick and cool. */
function toLlama(messages: Message[]): RNLlamaOAICompatibleMessage[] {
  const lastWithImages = messages.map((m) => !!m.images?.length).lastIndexOf(true);
  return messages.map((m, i) =>
    i === lastWithImages
      ? {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...m.images!.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } })),
        ],
      }
      : { role: m.role, content: m.content },
  ) as RNLlamaOAICompatibleMessage[];
}

const models: ModelManager = {
  chatModels: () => CHAT_MODELS.map((s) => ({ ...s, downloaded: isDownloaded(s) })),
  searchModel: () => ({ ...SEARCH_MODEL, downloaded: isDownloaded(SEARCH_MODEL) }),
  visionModel: () => ({ ...VISION_MODEL, downloaded: isDownloaded(VISION_MODEL), forModel: VISION_FOR }),
  // The 4B needs about 4.5 GB while it answers. Phones sold with 8 GB report about 7.3-7.6 GB; below that, the 2B.
  recommended: () => {
    const total = nativeLibrary?.totalMemory?.() ?? 0;
    return total > 0 && total < 7e9 ? 'qwen3.5-2b' : 'qwen3.5-4b';
  },

  async download(id, onProgress, signal) {
    const s = spec(id);
    if (!s) throw new Error('Unknown model.');
    const target = modelFile(s);
    if (doneMarker(s).exists) doneMarker(s).delete();
    if (target.exists && target.size > s.size) target.delete(); // not a partial of this file
    const options = {
      onProgress: ({ bytesWritten }: { bytesWritten: number }) => onProgress(bytesWritten / s.size),
      signal,
    };
    // Android drops the connection when the app goes into the background, and Wi-Fi can blip.
    // So carry on from the bytes already saved (an HTTP Range request) rather than starting again:
    // straight away for an earlier partial download, and after a drop once the app is back in front.
    for (let tries = 0; ; tries++) {
      const have = target.exists ? target.size : 0;
      try {
        const result = have > 0
          ? await DownloadTask.fromSavable({ url: s.url, fileUri: target.uri, isDirectory: false, resumeData: String(have) }, options).resumeAsync()
          : await File.createDownloadTask(s.url, target, options).downloadAsync();
        if (result) break;
        throw new Error('paused');
      } catch (e) {
        if (signal.aborted) {
          if (target.exists) target.delete(); // cancelled: don't leave gigabytes behind
          throw e;
        }
        if ((target.exists ? target.size : 0) > have) tries = 0; // it got further, so this isn't a stuck download
        if (tries >= 8) {
          throw new Error(`The download keeps stopping, so it's paused at ${Math.round((have / s.size) * 100)}%. Check the Wi-Fi, then tap Download to carry on`);
        }
        await whenInFront(signal);
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** tries))); // give the connection a moment
      }
    }
    // Downloads are pinned to an exact version; a size mismatch means a broken or altered file.
    if (target.size !== s.size) {
      target.delete();
      throw new Error("The downloaded file wasn't complete or didn't match. Please try again");
    }
    doneMarker(s).create();
    doneMarker(s).write(new Date().toISOString());
  },

  async remove(id) {
    const s = spec(id);
    if (!s) return;
    await unload();
    if (modelFile(s).exists) modelFile(s).delete();
    if (doneMarker(s).exists) doneMarker(s).delete();
  },
};

/** Ask the chat's model for JSON (learning, tidying) without losing its reading of the chat. */
async function askJson(ctx: LlamaContext, messages: Message[], maxTokens: number): Promise<string> {
  // Learning and tidying ask the chat's model something else, which would replace its reading of the chat (on a
  // phone CPU, about a minute of work for a long chat). Save that reading to a file first and load it back after,
  // so the next message only reads what's new. If either step fails, the next message just reads it all again.
  const state = new File(Paths.cache, 'chat-state.bin');
  const saved = await ctx.saveSession(state.uri).catch(() => 0);
  try {
    const result = await ctx.completion({
      messages: toLlama(messages.map(({ images: _i, ...m }) => m)), n_predict: maxTokens, temperature: 0, stop: STOP,
      jinja: true, enable_thinking: false, response_format: { type: 'json_object' },
    });
    return result.text ?? '';
  } finally {
    if (saved > 0) await ctx.loadSession(state.uri).catch(() => undefined);
    try {
      if (state.exists) state.delete();
    } catch {
      // a leftover file in the cache folder is harmless; it's replaced next time
    }
    touch();
  }
}

export const deviceEngine: Engine = {
  where: 'phone',
  models,

  configure(opts) {
    if (opts.accel !== accel || opts.performance !== performance) {
      accel = opts.accel;
      performance = opts.performance;
      unload(); // the next reply loads the model with the new settings
    }
  },

  lastSpeed: () => speed,

  vision: (modelId) => modelId === VISION_FOR && isDownloaded(VISION_MODEL),

  async status(modelId) {
    const s = spec(modelId);
    if (!s || !isDownloaded(s)) {
      const any = CHAT_MODELS.find(isDownloaded);
      if (!any) {
        return { ready: false, needsModel: true, label: 'No model yet', problem: 'Download a model in Settings to start. After that it works offline.' };
      }
      return { ready: false, needsModel: true, label: 'Choose a model', problem: 'Pick one of your downloaded models in Settings.' };
    }
    return { ready: true, label: "This phone's AI", model: s.name };
  },

  async warm(modelId, system) {
    const s = spec(modelId);
    if (performance !== 'cool' && s && isDownloaded(s)) { // Cool mode only loads the model when you send
      const ctx = await chatContext(modelId);
      if (system && !prefilling) {
        // Read the system message now, while they look at the screen or type. llama.rn keeps a save point after it,
        // so the first message only reads what's typed (about 25 s less on a phone CPU). One token is written and
        // dropped. A message sent meanwhile waits for this rather than reading it all again.
        prefilling = ctx.completion({ prompt: chatmlSystem(system), n_predict: 1, temperature: 0 })
          .then(() => undefined, () => undefined)
          .finally(() => { prefilling = null; });
        await prefilling;
      }
      touch();
    }
  },

  async chat(messages, modelId, onToken, maxTokens = 1024) {
    const ctx = await chatContext(modelId);
    if (prefilling) await prefilling;
    if (asking) {
      // Learning from the last message is a bonus: stop it so this one starts now. Its reading of the chat is put back.
      await ctx.stopCompletion().catch(() => undefined);
      await asking.catch(() => undefined);
    }
    if (messages.some((m) => m.images?.length)) await ensureVision(ctx);
    try {
      // Photos need llama.rn's own template; everything else is written as the model generated it (see chatml.ts),
      // so a follow-up only reads the new message.
      const sampling = { n_predict: maxTokens, temperature: 0.6, top_p: 0.9, stop: STOP };
      const result = await ctx.completion(
        messages.some((m) => m.images?.length)
          ? { ...sampling, messages: toLlama(messages), jinja: true, enable_thinking: false }
          : { ...sampling, prompt: chatmlPrompt(messages) },
        (data) => {
          if (data.token) onToken(data.token);
        },
      );
      const t = result.timings;
      speed = t?.predicted_per_second ?? null;
      // How the time split: tokens read afresh (the rest came from the saved reading) and tokens written.
      console.log(`[ember] ${speed?.toFixed(1)} tok/s on ${accel}; read ${t?.prompt_n ?? '?'} new tokens in `
        + `${((t?.prompt_ms ?? 0) / 1000).toFixed(1)} s, wrote ${t?.predicted_n ?? '?'}`);
      return result.text ?? '';
    } finally {
      touch();
    }
  },

  async json(messages, modelId, maxTokens = 256) {
    const ctx = await chatContext(modelId);
    if (prefilling) await prefilling;
    if (asking) await asking.catch(() => undefined);
    const job = askJson(ctx, messages, maxTokens);
    asking = job;
    try {
      return await job;
    } finally {
      if (asking === job) asking = null;
    }
  },

  async embed(texts, kind) {
    const ctx = await embedContext();
    if (!ctx) return null;
    const out: number[][] = [];
    for (const t of texts) out.push(normalise((await ctx.embedding(`search_${kind}: ${t}`)).embedding));
    touch();
    return out;
  },

  stop() {
    chatCtx?.stopCompletion();
  },
};

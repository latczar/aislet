// Ollama engine: the bigger model on the laptop. The PC talks to Ollama directly; the phone
// reaches the same model through the laptop hub, which passes requests on.
import { normalise } from '../brain';
import { HubError, type HubReply, readLines } from '../hub';
import { fetch as netFetch } from '../net';
import type { Message, Performance } from '../types';
import type { Engine } from './types';

export const CHAT_MODEL = 'qwen3.5:9b';
// Preferred chat models, best first. The installer pulls the one that suits the computer.
const PREFERRED = ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3:8b', 'qwen3:4b', 'llama3.1:8b', 'gemma3:4b'];

/** Pick the best installed chat model (embedding models can't chat). */
export function pickModel(names: string[]): string | null {
  const chat = names.filter((n) => !/embed|bge|minilm/i.test(n));
  return PREFERRED.find((p) => chat.includes(p)) ?? chat.find((n) => n.startsWith('qwen')) ?? chat[0] ?? null;
}
const EMBED_MODEL = 'nomic-embed-text';

/** Send a request to Ollama: straight to it on the laptop, or through the laptop hub's private link on the phone. */
export type OllamaSend = (method: 'GET' | 'POST', path: string, body: string | undefined, signal?: AbortSignal) => Promise<HubReply>;

/** Ollama on this computer, asked directly. */
function direct(base: string): OllamaSend {
  return async (method, path, body, signal) => {
    const res = (await netFetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body, signal })) as unknown as Response;
    return { ok: res.ok, status: res.status, text: () => res.text(), lines: (onLine) => readLines(res, onLine) };
  };
}

interface Options {
  send: OllamaSend;
  where: 'laptop' | 'phone';
  label: string; // e.g. "This laptop's AI" or "Your laptop's AI"
}

/** Ollama's message format. Only the latest photos are sent, to keep replies quick. */
function toOllama(messages: Message[]) {
  const lastWithImages = messages.map((m) => !!m.images?.length).lastIndexOf(true);
  return messages.map((m, i) => ({
    role: m.role,
    content: m.content,
    ...(i === lastWithImages ? { images: m.images } : {}),
  }));
}

// How long the laptop keeps the model loaded after a reply: longer means instant replies, shorter frees the GPU.
const KEEP_ALIVE: Record<Performance, string> = { cool: '1m', balanced: '5m', max: '30m' };

export function createOllamaEngine({ send, where, label }: Options): Engine {
  let controller: AbortController | null = null;
  let keepAlive = KEEP_ALIVE.balanced;
  let model = CHAT_MODEL;

  async function post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<HubReply> {
    let res: HubReply;
    try {
      res = await send('POST', path, JSON.stringify(body), signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new Error(where === 'laptop'
        ? "Can't reach Ollama on this laptop. It may still be starting, so try again in a few seconds."
        : "Can't reach your laptop. Check it's on and on the same Wi-Fi.");
    }
    if (!res.ok) {
      // From the phone, a reply that isn't really from the laptop throws here, with our own message.
      const data = await res.text().then(JSON.parse).catch((e) => (e instanceof HubError ? { error: e.message } : {}));
      const msg: string = data.error || `The model returned an error (${res.status}).`;
      throw new Error(msg.includes('not found') ? `${msg}. Fix: run "ollama pull ${body.model}" on the laptop.` : msg);
    }
    return res;
  }

  return {
    where,

    async status() {
      try {
        const res = await send('GET', '/api/tags', undefined);
        const data = await res.text().then(JSON.parse).catch((e) => (e instanceof HubError ? { refused: e.message } : {}));
        if (data.refused) return { ready: false, label: 'Laptop', problem: data.refused };
        if (!res.ok) {
          return { ready: false, label: 'Laptop', problem: data.error || `The laptop replied with an error (${res.status}).`, starting: res.status === 503 };
        }
        const names: string[] = (data.models ?? []).map((m: { name: string }) => m.name);
        const best = pickModel(names);
        if (!best) {
          return { ready: false, label: 'No model', problem: `No AI model is installed in Ollama yet. Run "ollama pull ${CHAT_MODEL}".` };
        }
        model = best;
        return { ready: true, label, model };
      } catch (e) {
        if (e instanceof HubError) return { ready: false, label: 'Laptop', problem: e.message }; // the phone couldn't reach the laptop
        return { ready: false, label: 'Ollama', problem: "Ollama isn't running. Start the Ollama app on the laptop." };
      }
    },

    vision: () => true, // qwen3.5 understands images

    configure(opts) {
      keepAlive = KEEP_ALIVE[opts.performance] ?? KEEP_ALIVE.balanced;
    },

    async chat(messages, _modelId, onToken, maxTokens = 1024) {
      controller = new AbortController();
      const res = await post(
        '/api/chat',
        {
          model, messages: toOllama(messages), stream: true, think: false, keep_alive: keepAlive,
          options: { num_ctx: 8192, temperature: 0.6, num_predict: maxTokens },
        },
        controller.signal,
      );
      let full = '';
      try {
        await res.lines((line) => {
          const part = JSON.parse(line);
          if (part.error) throw new Error(part.error);
          const text: string = part.message?.content ?? '';
          if (text) {
            full += text;
            onToken(text);
          }
        });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') throw e; // stopped by the user: keep what we have
      }
      return full;
    },

    async json(messages, _modelId, maxTokens = 256) {
      const res = await post('/api/chat', {
        model, messages: toOllama(messages), stream: false, think: false, format: 'json', keep_alive: keepAlive,
        // The same context size as chat: a different one makes Ollama reload the model (8–11 s with the 9B),
        // once for learning and again for the next reply.
        options: { num_ctx: 8192, temperature: 0, num_predict: maxTokens },
      });
      return JSON.parse(await res.text()).message?.content ?? '';
    },

    async embed(texts, kind) {
      try {
        const res = await post('/api/embed', { model: EMBED_MODEL, input: texts.map((t) => `search_${kind}: ${t}`), keep_alive: keepAlive });
        return (JSON.parse(await res.text()).embeddings as number[][]).map(normalise);
      } catch {
        return null; // notes search falls back to matching words
      }
    },

    stop() {
      controller?.abort();
    },
  };
}

export const ollamaEngine = createOllamaEngine({ send: direct('http://localhost:11434'), where: 'laptop', label: "This laptop's AI" });

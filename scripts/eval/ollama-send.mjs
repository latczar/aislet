// The `send` the app's Ollama engine uses, for Node: straight to Ollama (as the PC app does), or through a
// hub as the laptop's own window (headers: { 'X-Key': token }). It can fix the seed and the model, and it keeps
// Ollama's own timings from the last line of each reply in `timing.last`.
import { readLines } from './stubs/hub.mjs';

export function createSend(base, seed, timing, model, headers = {}) {
  return async (method, path, body, signal) => {
    if (body && path === '/api/chat') {
      const data = JSON.parse(body);
      if (model) data.model = model;
      data.options = { ...data.options, seed: seed() };
      body = JSON.stringify(data);
    }
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body, signal });
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      lines: (onLine) => readLines(res, (line) => {
        const part = JSON.parse(line);
        if (part.done) {
          timing.last = {
            promptTokens: part.prompt_eval_count ?? 0,
            promptMs: Math.round((part.prompt_eval_duration ?? 0) / 1e6),
            loadMs: Math.round((part.load_duration ?? 0) / 1e6),
            outputTokens: part.eval_count ?? 0,
            outputMs: Math.round((part.eval_duration ?? 0) / 1e6),
          };
        }
        onLine(line);
      }),
    };
  };
}

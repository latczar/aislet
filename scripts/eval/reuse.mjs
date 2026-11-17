// How much of each prompt the model has to read again, message by message, in a made-up four-message chat:
// the app's layout (a fixed system message, with what the app adds kept with each message) against the old one
// (what the app adds put in the system message, so it changes with every message).
//
//   node scripts/eval/reuse.mjs [--model qwen3.5:4b] [--url http://localhost:11434]
//
// For each message it prints the prompt's size and the time Ollama took to read it. When the start of a prompt
// matches the one before, Ollama reuses that reading, so a follow-up should take a fraction of the first message.
// On the laptop this shows on Ollama's log too ("restored context checkpoint … n_past"). Made-up data only.
import { brain } from './app.mjs';
import { MEMORIES, NOTES, SETTINGS } from './cases.mjs';

const opt = { url: 'http://localhost:11434', model: 'qwen3.5:9b' };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, '')] = a[i + 1];

const TURNS = [
  { ask: 'What pressure should my boiler be at?', notes: NOTES },
  { ask: 'And how do I top it up?', notes: NOTES },
  { ask: 'Set a timer for 10 minutes while it settles.', actions: true },
  { ask: 'Thanks. What temperature should the radiators run at?' },
];

async function send(messages, seed) {
  const res = await fetch(`${opt.url}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: opt.model, messages, stream: false, think: false, keep_alive: '5m',
      options: { num_ctx: 8192, temperature: 0.6, num_predict: 160, seed },
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return { reply: d.message.content, tokens: d.prompt_eval_count, readMs: Math.round(d.prompt_eval_duration / 1e6) };
}

async function chat(layout) {
  const now = new Date('2026-11-18T10:00:00');
  // A different first line each run, so neither layout reuses the other's reading.
  const system = `${brain.systemPrompt(SETTINGS, MEMORIES, 'phone', true)}\n(run ${layout} ${Date.now()})`;
  const history = [];
  const rows = [];
  for (const [i, t] of TURNS.entries()) {
    const added = brain.turnContext(SETTINGS.name, { notes: t.notes, actions: t.actions }, now);
    let messages;
    if (layout === 'app') {
      // As src/store.tsx: what the app adds stays with its message for the rest of the chat.
      const latest = { role: 'user', content: added ? `${added}\n\n${t.ask}` : t.ask };
      messages = [{ role: 'system', content: system }, ...history, latest];
      history.push(latest);
    } else {
      // Before: what the app adds went in the system message, and only for this message.
      messages = [{ role: 'system', content: added ? `${system}\n\n${added}` : system }, ...history, { role: 'user', content: t.ask }];
      history.push({ role: 'user', content: t.ask });
    }
    const r = await send(messages, 7 + i);
    history.push({ role: 'assistant', content: r.reply });
    rows.push(r);
    console.log(`  ${layout.padEnd(6)} message ${i + 1}: prompt ${String(r.tokens).padStart(5)} tokens, read in ${String(r.readMs).padStart(5)} ms`);
  }
  return rows;
}

console.log(`${opt.model}:`);
const before = await chat('before');
const after = await chat('app');
const later = (rows) => rows.slice(1).reduce((n, r) => n + r.readMs, 0);
console.log(`Messages 2-4 read in ${later(before)} ms before, ${later(after)} ms with the app's layout.`);

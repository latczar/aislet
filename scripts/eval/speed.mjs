// Speed and prompt-size baseline for the laptop model, with made-up data and the app's own prompt code.
//
//   node scripts/eval/speed.mjs tokens                 system prompt sizes in tokens (no memories, 20, web on…)
//   node scripts/eval/speed.mjs speed                  first word and words per second, straight to Ollama (the PC app)
//   node scripts/eval/speed.mjs speed --hub http://127.0.0.1:8767 --key <local_token>
//                                                      the same through a hub, as the laptop's own window
//
// Options: --url (Ollama, default http://localhost:11434), --model (default: the app's pick), --runs (default 5).
// Only ever point --hub at a test hub with its own data folder, never the live one.
import { brain, buildMessages, createOllamaEngine } from './app.mjs';
import { CASES, MEMORIES, MORE_MEMORIES, SETTINGS } from './cases.mjs';
import { createSend } from './ollama-send.mjs';

const opt = { url: 'http://localhost:11434', runs: 5 };
const [mode, ...rest] = process.argv.slice(2);
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
opt.runs = Number(opt.runs);

const PROMPT = 'E2E check: explain briefly how a heat pump heats a home.'; // the same as scripts/eval/phone_speed.py
const FOLLOW_UP = 'And compare its running cost with a gas boiler.';
const words = (t) => t.split(/\s+/).filter((w) => /\w/.test(w)).length;

const WEB5 = {
  query: 'heat pump running costs',
  hits: Array.from({ length: 5 }, (_, i) => ({
    title: `Made-up result ${i + 1} about heat pump running costs`,
    url: `https://site${i + 1}.example.org/heat-pumps/running-costs-${i + 1}`,
    snippet: 'A typical air source heat pump uses about a third of the energy of a gas boiler for the same heat, ' +
      'but electricity costs more per unit, so running costs depend on the tariff and how well the home is insulated.',
  })),
};

async function pickModel() {
  if (opt.model) return opt.model;
  const engine = createOllamaEngine({ send: createSend(opt.url, () => 0, {}), where: 'laptop', label: 'speed' });
  const s = await engine.status();
  if (!s.ready) throw new Error(s.problem);
  return s.model;
}

/** Tokens Ollama evaluates for these messages. A random number first means nothing is reused from its cache. */
async function promptTokens(model, messages) {
  const nonce = String(Math.floor(100000 + Math.random() * 899999));
  const [system, ...others] = messages;
  const body = {
    model, stream: false, think: false, keep_alive: '5m',
    messages: [{ role: 'system', content: `${nonce}\n${system.content}` }, ...others],
    options: { num_ctx: 8192, num_predict: 1 },
  };
  const res = await fetch(`${opt.url}/api/chat`, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json();
  return data.prompt_eval_count;
}

async function tokens() {
  const model = await pickModel();
  const ask = { ask: PROMPT };
  const empty = await promptTokens(model, [{ role: 'system', content: '' }, { role: 'user', content: PROMPT }]);
  const rows = [
    ['No memories', buildMessages(ask, [])],
    ['8 memories (the eval set)', buildMessages(ask, MEMORIES)],
    ['20 memories', buildMessages(ask, [...MEMORIES, ...MORE_MEMORIES])],
    ['20 memories + Search the web on, 5 results', buildMessages({ ...ask, webSearch: true, web: WEB5 }, [...MEMORIES, ...MORE_MEMORIES])],
    ['20 memories + phone alarm/timer instructions', buildMessages({ ...ask, where: 'phone', actions: true }, [...MEMORIES, ...MORE_MEMORIES])],
    ['20 memories + Get to know me', buildMessages({ ...ask, mode: 'interview' }, [...MEMORIES, ...MORE_MEMORIES])],
    ['No memories + 1 note and 1 library passage', buildMessages({ ...ask, notes: CASES.find((c) => c.notes).notes, library: CASES.find((c) => c.library).library }, [])],
  ];
  console.log(`System prompt sizes for ${model} (the user's message and chat template take ${empty} tokens on their own):`);
  for (const [label, messages] of rows) {
    const total = await promptTokens(model, messages);
    console.log(`  ${label.padEnd(48)} ${String(total - empty).padStart(5)} tokens  (${messages[0].content.length} characters)`);
  }
}

/** One message, timed the way a person sees it: from pressing Send to the first word, then the rest. */
async function timedChat(engine, messages) {
  let answer = '';
  let first = null;
  const started = performance.now();
  await engine.chat(messages, undefined, (token) => {
    if (first === null && token.trim()) first = performance.now();
    answer += token;
  }, brain.MAX_TOKENS[SETTINGS.length]);
  const ended = performance.now();
  answer = brain.stripThinking(answer).trim();
  return {
    answer,
    firstWordMs: Math.round(first - started),
    totalMs: Math.round(ended - started),
    wordsPerSecond: words(answer) / ((ended - first) / 1000),
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function speed() {
  const model = await pickModel();
  const timing = { last: null };
  let seed = 1;
  const base = opt.hub ?? opt.url;
  const headers = opt.hub ? { 'X-Key': opt.key } : {};
  const engine = createOllamaEngine({ send: createSend(base, () => seed, timing, model, headers), where: 'laptop', label: 'speed' });
  const first = buildMessages({ ask: PROMPT });
  const row = (label, r) => {
    const t = timing.last;
    const tokPerSec = t.outputMs ? (t.outputTokens / (t.outputMs / 1000)).toFixed(1) : '-';
    console.log(`  ${label.padEnd(26)} first word ${String(r.firstWordMs).padStart(5)} ms  ${r.wordsPerSecond.toFixed(1).padStart(5)} words/s  ` +
      `${tokPerSec} tok/s  prompt ${t.promptTokens} tok in ${t.promptMs} ms  load ${t.loadMs} ms  ${words(r.answer)} words`);
    return { ...r, ...t };
  };
  console.log(`${model} via ${opt.hub ? `hub ${opt.hub}` : `Ollama ${opt.url}`}:`);
  // Cold: the model isn't loaded (as after Balanced's 5 minutes idle).
  await fetch(`${opt.url}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) });
  await new Promise((r) => setTimeout(r, 2000));
  const cold = row('cold (model not loaded)', await timedChat(engine, first));
  const warm = [];
  for (let i = 0; i < opt.runs; i++) {
    seed = 100 + i;
    warm.push(row(`new chat ${i + 1}`, await timedChat(engine, first)));
  }
  const reply = warm[0].answer;
  const follow = [];
  for (let i = 0; i < opt.runs; i++) {
    seed = 200 + i;
    const messages = [...first, { role: 'assistant', content: reply }, { role: 'user', content: FOLLOW_UP }];
    follow.push(row(`follow-up ${i + 1}`, await timedChat(engine, messages)));
  }
  const m = (xs, k) => median(xs.map((x) => x[k]));
  console.log(`  median, new chat:  first word ${m(warm, 'firstWordMs')} ms, ${m(warm, 'wordsPerSecond').toFixed(1)} words/s, ` +
    `${median(warm.map((x) => x.outputTokens / (x.outputMs / 1000))).toFixed(1)} tok/s`);
  console.log(`  median, follow-up: first word ${m(follow, 'firstWordMs')} ms, ${m(follow, 'wordsPerSecond').toFixed(1)} words/s`);
  console.log(`  cold first word: ${cold.firstWordMs} ms (load ${cold.loadMs} ms)`);
}

if (mode === 'tokens') await tokens();
else if (mode === 'speed') await speed();
else console.log('Usage: node scripts/eval/speed.mjs tokens|speed [--hub URL --key TOKEN] [--model NAME] [--runs N]');

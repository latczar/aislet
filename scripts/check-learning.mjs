// Learning eval: does the model, given the app's own learning prompt (src/brain.ts), save the right facts?
// Corrections become preferences, a changed fact replaces the old one, unrelated facts don't, and one-off
// requests or things only the reply said aren't saved. Made-up data only. Talks to Ollama on this computer.
//   node scripts/check-learning.mjs                     qwen3.5:4b (the phone's default size)
//   node scripts/check-learning.mjs --model qwen3.5:9b
// Needs Node 22.18+ (it loads the app's TypeScript directly). Exit code 0 only if every case passes.
import { registerHooks } from 'node:module';

const EMPTY = 'data:text/javascript,export default {}; export const Platform = { OS: "web", select: (o) => o.web ?? o.default };'
  + ' export function requireOptionalNativeModule() { return null; }';
registerHooks({
  resolve(specifier, context, next) {
    if (/^(expo|react-native)/.test(specifier)) return { url: EMPTY, shortCircuit: true };
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.includes('/src/')) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          return next(specifier + ext, context);
        } catch {
          // try the next extension
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') && url.includes('/src/')) return next(url, { ...context, format: 'module-typescript' });
    return next(url, context);
  },
});
const brain = await import('../src/brain.ts');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL_ = arg('url', 'http://127.0.0.1:11434');
const MODEL = arg('model', 'qwen3.5:4b');

async function post(path, body) {
  const res = await fetch(`${URL_}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
// The same request the app's Ollama engine makes for learning (src/engine/ollama.ts, json()).
const json = async (messages) => (await post('/api/chat', {
  model: MODEL, messages, stream: false, think: false, format: 'json', options: { num_ctx: 4096, temperature: 0, num_predict: 256 },
})).message.content;
const embed = async (texts) => (await post('/api/embed', { model: 'nomic-embed-text', input: texts.map((t) => `search_document: ${t}`) }))
  .embeddings.map(brain.normalise);

const fact = (id, text, category) => ({ id, fact: text, added: '2026-11-01', category });
const KNOWN = [
  fact('job', 'Sam works at Acme as an accountant', 'projects'),
  fact('pref', 'Sam prefers detailed answers', 'preferences'),
  fact('home', 'Sam lives in Lisbon', 'about'),
  fact('cat', 'Sam has a cat called Miso', 'about'),
  fact('run', 'Sam is training for a 10k in March', 'goals'),
];
const LONG_REPLY = 'Tea has a long history. It began in China, where legend says Emperor Shen Nong discovered it around 2737 BC. '
  + 'From there it spread to Japan with Buddhist monks, then along trade routes to India and Europe, where…';

const CASES = [
  { id: 'correction-length', say: 'too long, just give me the gist next time', reply: LONG_REPLY,
    want: { category: 'preferences', match: /short|brief|concise|gist|less detail/i, replaces: 'pref' } },
  { id: 'correction-lists', say: 'no bullet points please, I like plain paragraphs', reply: '- Point one\n- Point two\n- Point three',
    want: { category: 'preferences', match: /list|bullet|paragraph|prose/i } },
  { id: 'new-job', say: 'I started a new job at Globex last week, as a designer',
    want: { category: 'projects', match: /globex/i, replaces: 'job' } },
  { id: 'moved', say: "I've just moved to Porto", want: { match: /porto/i, replaces: 'home' } },
  { id: 'second-pet', say: "We're adopting a dog called Rex too", want: { match: /rex/i, replaces: null } },
  { id: 'goal-unrelated', say: "I've started learning Spanish on my lunch breaks", want: { match: /spanish/i, replaces: null } },
  { id: 'one-off', say: 'remind me to call my mum at 6', want: { none: true } },
  { id: 'reply-only', say: "thanks, that's really useful", reply: LONG_REPLY, want: { none: true } },
];

let failed = 0;
for (const c of CASES) {
  const known = brain.relevantMemories(KNOWN, c.say, 40);
  const raw = await json(brain.learnMessages('Sam', known, c.say, c.reply ?? ''));
  const facts = brain.parseFacts(raw, known, 'Sam');
  // As the app does (store.tsx, learnFact): a "maybe" only counts when the facts are this close in meaning.
  for (const f of facts) {
    if (!f.replaces && f.maybe) {
      const [a, b] = await embed([f.maybe.fact, f.fact]);
      if (brain.similarity(a, b) >= brain.SAME_THING) f.replaces = f.maybe;
    }
    f.category = f.replaces?.category ?? f.category; // an update stays where the old fact was filed
  }
  const problems = [];
  if (c.want.none) {
    if (facts.length) problems.push(`saved ${facts.map((f) => `"${f.fact}"`).join(', ')}`);
  } else {
    const hit = facts.find((f) => c.want.match.test(f.fact));
    if (!hit) problems.push(`no fact matching ${c.want.match}`);
    else {
      if (c.want.category && hit.category !== c.want.category) problems.push(`category ${hit.category}`);
      if (c.want.replaces !== undefined && (hit.replaces?.id ?? null) !== c.want.replaces) {
        problems.push(`replaces ${hit.replaces?.id ?? 'nothing'}, wanted ${c.want.replaces ?? 'nothing'}`);
      }
    }
    if (facts.some((f) => /\b(tea|china|emperor)\b/i.test(f.fact))) problems.push('saved something only the reply said');
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'pass'} ${c.id}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length) console.log(`     ${raw.replace(/\s+/g, ' ').slice(0, 300)}`);
}
console.log(`${MODEL}: ${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);

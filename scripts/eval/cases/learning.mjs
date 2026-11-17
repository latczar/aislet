// Learning: given the app's own learning prompt (src/brain.ts, learnMessages), does the model save the right facts?
// Corrections become preferences, a changed fact points at the one it replaces, unrelated facts don't, and
// one-off requests or things only the reply said aren't saved. Made-up data only.
//   node scripts/eval/run.mjs --only learning [--model qwen3.5:4b]
// "replaces" is checked as the model gave it; the app's own guard (same kind and a shared word, or close in
// meaning) is tested without a model in scripts/eval/memory.mjs.
import { brain } from '../app.mjs';
import { fact } from '../cases.mjs';

const KNOWN = [
  fact('job', 'Sam works at Acme as an accountant', 'projects'),
  fact('pref', 'Sam prefers detailed answers', 'preferences'),
  fact('home', 'Sam lives in Lisbon', 'about'),
  fact('cat', 'Sam has a cat called Miso', 'about'),
  fact('run', 'Sam is training for a 10k in March', 'goals'),
];
const LONG_REPLY = 'Tea has a long history. It began in China, where legend says Emperor Shen Nong discovered it around 2737 BC. '
  + 'From there it spread to Japan with Buddhist monks, then along trade routes to India and Europe, where…';

/** The facts as the app reads them, with what each one points at ("replaces", or a "maybe" for the app to check). */
function read(x, say) {
  const known = brain.relevantMemories(KNOWN, say, 40);
  return brain.parseFacts(JSON.stringify(x.data ?? {}), known, 'Sam')
    .map((f) => ({ ...f, points: (f.replaces ?? f.maybe)?.id ?? null }));
}

function learning(id, say, want, reply = '') {
  const checks = [];
  if (want.none) {
    checks.push(['saves nothing', (_a, x) => read(x, say).length === 0]);
  } else {
    const hit = (x) => read(x, say).find((f) => want.match.test(f.fact));
    checks.push([`saves a fact matching ${want.match}`, (_a, x) => !!hit(x)]);
    if (want.category) checks.push([`as ${want.category}`, (_a, x) => hit(x)?.category === want.category]);
    if (want.replaces !== undefined) {
      checks.push([want.replaces ? `says it replaces "${want.replaces}"` : 'replaces nothing', (_a, x) => (hit(x)?.points ?? null) === want.replaces]);
    }
    checks.push(['nothing only the reply said', (_a, x) => !read(x, say).some((f) => /\b(tea|china|emperor)\b/i.test(f.fact))]);
  }
  return {
    id, group: 'learning', json: true,
    build: () => brain.learnMessages('Sam', brain.relevantMemories(KNOWN, say, 40), say, reply),
    checks,
  };
}

export const CASES = [
  learning('learn-correction-length', 'too long, just give me the gist next time',
    { category: 'preferences', match: /short|brief|concise|gist|less detail/i, replaces: 'pref' }, LONG_REPLY),
  learning('learn-correction-lists', 'no bullet points please, I like plain paragraphs',
    { category: 'preferences', match: /list|bullet|paragraph|prose/i }, '- Point one\n- Point two\n- Point three'),
  learning('learn-new-job', 'I started a new job at Globex last week, as a designer', { match: /globex/i, replaces: 'job' }),
  learning('learn-moved', "I've just moved to Porto", { match: /porto/i, replaces: 'home' }),
  learning('learn-second-pet', "We're adopting a dog called Rex too", { match: /rex/i, replaces: null }),
  learning('learn-unrelated-goal', "I've started learning Spanish on my lunch breaks", { match: /spanish/i, replaces: null }),
  learning('learn-one-off', 'remind me to call my mum at 6', { none: true }),
  learning('learn-reply-only', "thanks, that's really useful", { none: true }, LONG_REPLY),
];

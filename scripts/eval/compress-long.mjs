// Compress on a long memory: 59 made-up facts in one category, in a fixed jumbled order, sent as the app sends them
// (compressBatches, then parseCompress). It counts what would be offered: merges, merges that join different
// topics (wrong), topics merged, and the facts and words left if every merge were applied. Made-up data only.
//   node scripts/eval/compress-long.mjs --model qwen3.5:4b
//   node scripts/eval/compress-long.mjs --model qwen3.5:4b --plain 60   (every fact, 60 a request: the first version)
import { brain, createOllamaEngine } from './app.mjs';
import { createSend } from './ollama-send.mjs';

// [topic, fact]. Facts on one topic should merge; the rest have nothing to merge with.
const TOPICS = [
  ['cat', 'Sam has a cat called Biscuit'], ['cat', 'Biscuit is a ginger tabby'], ['cat', 'Biscuit is four years old'],
  ['car', 'Sam drives a Kia Niro electric car'], ['car', 'Sam charges the Kia at home overnight'],
  ['job', 'Sam is a primary school teacher in Leeds'], ['job', 'Sam teaches Year 4 at the school'], ['job', "Sam's school is St Mary's Primary"],
  ['football', 'Sam plays five-a-side football on Tuesdays'], ['football', "Sam's five-a-side team is called the Rovers"],
  ['allergy', 'Sam is allergic to peanuts'], ['allergy', 'Sam carries an EpiPen for the peanut allergy'],
  ['diet', 'Sam is mostly vegetarian'], ['diet', "Sam's vegetarian diet includes fish at weekends"],
  ['home', 'Sam lives in a terraced house in Headingley'], ['home', "Sam's house has a small garden"], ['home', "Sam's house is near the Otley Road"],
  ['cork', 'Sam grew up in Cork'], ['cork', "Sam's parents still live in Cork"],
  ['choir', 'Sam sings in a choir on Wednesdays'], ['choir', "Sam's choir is rehearsing a Christmas concert"],
  ['ukulele', 'Sam plays the ukulele'], ['ukulele', 'Sam learnt the ukulele during lockdown'],
  ['crime', 'Sam reads crime novels'], ['crime', "Sam's favourite crime writer is Mara Quist"],
  ['cycling', 'Sam cycles to work'], ['cycling', 'Sam rides a blue road bike to work'], ['cycling', "Sam's cycle to work takes 20 minutes"],
  ['coffee', 'Sam drinks coffee with oat milk'], ['coffee', 'Sam has two coffees a day'],
  ['sleep', 'Sam goes to bed at 10:30 on weeknights'], ['sleep', 'Sam wakes up at 6:15 on weeknights'],
  ['allotment', 'Sam has an allotment in Meanwood'], ['allotment', 'Sam grows tomatoes on the allotment'], ['allotment', "Sam's allotment plot is number 14"],
];
const ALONE = ['Sam is left-handed', 'Sam is 34', 'Sam wears glasses', 'Sam speaks a little Irish', 'Sam is afraid of heights',
  'Sam has a tattoo of a swallow', 'Sam volunteers at a food bank on Saturdays', 'Sam is colour-blind', 'Sam was born in March',
  'Sam enjoys board games', 'Sam swims at the leisure centre', 'Sam does a crossword every morning', 'Sam dislikes coriander',
  'Sam keeps a sourdough starter', 'Sam watches Formula 1', 'Sam knits scarves in winter', 'Sam collects vinyl records',
  'Sam owns a 3D printer', 'Sam takes the bus when it rains', 'Sam does chess puzzles online', 'Sam is training for a half marathon',
  'Sam has never been to Japan', 'Sam is an only child', 'Sam prefers tea in the evening'];

/** The same jumbled order every run (facts are learnt over time, so related ones are rarely side by side). */
function jumbled(items, seed = 7) {
  const out = [...items];
  let a = seed;
  const rand = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const facts = jumbled([...TOPICS, ...ALONE.map((f, i) => [`alone${i}`, f])])
  .map(([topic, fact], i) => ({ id: `f${i + 1}`, fact, topic, category: 'about', added: '2026-11-01' }));
const topicOf = new Map(facts.map((m) => [m.id, m.topic]));

const opt = { url: 'http://localhost:11434', model: undefined, plain: 0 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) opt[argv[i].replace(/^--/, '')] = argv[++i];
const batches = Number(opt.plain) ? brain.tidyGroups(facts, Number(opt.plain)) : brain.compressBatches(facts, 'Sam');
if ('dry' in opt) { // --dry 1: show what would be sent, without a model
  batches.forEach((b, i) => console.log(`request ${i + 1}:\n${b.map((m) => `  [${m.topic}] ${m.fact}`).join('\n')}`));
  process.exit(0);
}
const engine = createOllamaEngine({ send: createSend(opt.url, () => 42, { last: null }, opt.model), where: 'laptop', label: 'eval' });
const status = await engine.status();
if (!status.ready) throw new Error(status.problem);

const started = performance.now();
const changes = [];
for (const batch of batches) {
  const reply = await engine.json(brain.compressMessages('Sam', batch), undefined, 1500);
  changes.push(...brain.parseCompress(brain.stripThinking(reply), batch, 'Sam'));
}
const seconds = (performance.now() - started) / 1000;
const wrong = changes.filter((c) => new Set(c.remove.map((id) => topicOf.get(id))).size > 1);
const topics = new Set(changes.filter((c) => !wrong.includes(c)).map((c) => topicOf.get(c.remove[0])));
const gone = new Set(changes.flatMap((c) => c.remove));
const words = (list) => list.reduce((n, f) => n + f.split(/\s+/).length, 0);
const after = [...facts.filter((m) => !gone.has(m.id)).map((m) => m.fact), ...changes.map((c) => c.add.fact)];
for (const c of changes) console.log(`${wrong.includes(c) ? 'WRONG ' : ''}${c.remove.length} -> ${c.add.fact}`);
console.log(`\n${opt.model ?? status.model}, ${Number(opt.plain) ? `every fact, ${opt.plain} a request` : 'related facts only'}: `
  + `${batches.length} request(s), ${batches.reduce((n, b) => n + b.length, 0)} facts sent, ${seconds.toFixed(0)} s`);
console.log(`${changes.length} merges offered, ${wrong.length} wrong; ${topics.size}/15 topics merged; `
  + `if all applied: ${facts.length} -> ${after.length} facts, ${words(facts.map((m) => m.fact))} -> ${words(after)} words`);
process.exitCode = wrong.length ? 1 : 0;

// Compress memory: given the app's own prompt (src/brain.ts, compressMessages), does the model merge related facts
// into fewer, shorter ones, and do the merges the app would offer (parseCompress) keep to one topic? Merges that add
// or drop a detail are dropped by parseCompress, so they never count. Made-up data only.
//   node scripts/eval/run.mjs --only compress [--model qwen3.5:4b] [--runs 3]
// The rules that drop a bad merge are tested without a model in scripts/eval/memory.mjs.
import { brain } from '../app.mjs';
import { fact } from '../cases.mjs';

/** What the app would offer: merges that passed its checks. */
const offered = (x, group) => brain.parseCompress(JSON.stringify(x.data ?? {}), group, 'Sam');

/**
 * A case for one category. `topics` lists the facts that are about the same thing; a merge may only join facts from
 * one of them. `want` names the topics a good answer merges (at least two of its facts each).
 */
function compress(id, memories, topics, want) {
  const group = brain.tidyGroups(memories)[0];
  const topicOf = (factId) => Object.keys(topics).find((t) => topics[t].includes(factId)) ?? factId;
  const checks = [
    ['keeps each merge to one topic', (_a, x) => offered(x, group).every((c) => new Set(c.remove.map(topicOf)).size === 1)],
    ['never merges history', (_a, x) => offered(x, group).every((c) => c.remove.every((r) => !memories.find((m) => m.id === r)?.until))],
  ];
  for (const t of want) {
    checks.push([`merges the ${t} facts`, (_a, x) => offered(x, group).some((c) => c.remove.length >= 2 && c.remove.every((r) => topics[t].includes(r)))]);
  }
  if (!want.length) checks.push(['merges nothing', (_a, x) => offered(x, group).length === 0]);
  return { id, group: 'compress', json: true, maxTokens: 1500, build: () => brain.compressMessages('Sam', group), checks };
}

export const CASES = [
  compress('compress-pet', [
    fact('a1', 'Sam has a cat called Biscuit', 'about'),
    fact('a2', 'Biscuit is a ginger tabby', 'about'),
    fact('a3', 'Biscuit is four years old', 'about'),
    fact('a4', 'Sam is a primary school teacher in Leeds', 'about'),
    fact('a5', 'Sam is allergic to peanuts', 'about'),
    fact('a6', 'Sam drives a Kia Niro electric car', 'about'),
    fact('a7', 'Sam plays five-a-side football on Tuesdays', 'about'),
    { ...fact('a8', 'Sam has a dog called Rex', 'about'), until: '2026-06-01' },
  ], { cat: ['a1', 'a2', 'a3'] }, ['cat']),

  compress('compress-people', [
    fact('b1', "Sam's partner is called Priya", 'people'),
    fact('b2', 'Priya works as a nurse', 'people'),
    fact('b3', "Priya's birthday is on 14 March", 'people'),
    fact('b4', "Sam's brother Tom lives in Bristol", 'people'),
    fact('b5', 'Tom has two children', 'people'),
    fact('b6', "Sam's mum Linda has a birthday in June", 'people'),
  ], { priya: ['b1', 'b2', 'b3'], tom: ['b4', 'b5'] }, ['priya', 'tom']),

  compress('compress-goals', [
    fact('d1', 'Sam is training for a half marathon', 'goals'),
    fact('d2', "Sam's half marathon is in York in March", 'goals'),
    fact('d3', 'Sam runs three times a week', 'goals'),
    fact('d4', 'Sam is learning Spanish', 'goals'),
    fact('d5', 'Sam practises Spanish on the bus to work', 'goals'),
    fact('d6', 'Sam is saving for a deposit on a house', 'goals'),
  ], { running: ['d1', 'd2', 'd3'], spanish: ['d4', 'd5'] }, ['running', 'spanish']),

  compress('compress-projects', [
    fact('f1', 'Sam works as a data analyst at Northwind', 'projects'),
    fact('f2', "Sam's team at Northwind uses Python", 'projects'),
    fact('f3', 'Sam is building a shed on the allotment', 'projects'),
    fact('f4', "Sam's shed needs a new roof", 'projects'),
    fact('f5', 'Sam runs a book club on the first Thursday of each month', 'projects'),
  ], { work: ['f1', 'f2'], shed: ['f3', 'f4'] }, ['work', 'shed']),

  // How they like answers: all one topic, so any merge is fine, but there should be one.
  compress('compress-prefs', [
    fact('c1', 'Sam prefers short answers', 'preferences'),
    fact('c2', 'Sam prefers bullet points for instructions', 'preferences'),
    fact('c3', 'Sam dislikes long introductions in answers', 'preferences'),
    fact('c4', 'Sam likes recipes with metric measurements', 'preferences'),
    fact('c5', 'Sam wants British spelling', 'preferences'),
  ], { answers: ['c1', 'c2', 'c3', 'c4', 'c5'] }, ['answers']),

  // Nothing here is about the same thing.
  compress('compress-none', [
    fact('e1', 'Sam is allergic to peanuts', 'about'),
    fact('e2', 'Sam drives a Kia Niro electric car', 'about'),
    fact('e3', 'Sam sings in a choir on Wednesdays', 'about'),
    fact('e4', 'Sam grew up in Cork', 'about'),
    fact('e5', 'Sam is left-handed', 'about'),
  ], {}, []),
];

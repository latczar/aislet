// Checks for the learning and memory logic in src/brain.ts: replacing facts, history, looking back at
// earlier chats. Made-up data only. Needs Node 22.18+ (it loads the app's TypeScript directly).
//   node scripts/eval/memory.mjs
import './hooks.mjs'; // loads the app's own TypeScript, with stand-ins for Expo and React Native

const brain = await import('../../src/brain.ts');
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const fact = (id, text, category = 'about', extra = {}) => ({ id, fact: text, added: '2026-11-01', category, ...extra });
const known = [
  fact('a', 'Sam works at Acme as an accountant', 'projects'),
  fact('b', 'Sam prefers detailed answers', 'preferences'),
  fact('c', 'Sam lives in Lisbon'),
  fact('d', 'Sam has a cat called Miso'),
];

// ---- Replacing a known fact ----
let facts = brain.parseFacts(JSON.stringify({ facts: [
  { fact: 'Sam now works at Globex as a designer', category: 'projects', replaces: 1 },
  { fact: 'Sam prefers short answers', category: 'preferences', replaces: 2 },
] }), known, 'Sam');
check('replaces a fact sharing a word', facts[0].replaces?.id === 'a', JSON.stringify(facts[0]));
check('replaces a preference', facts[1].replaces?.id === 'b');

facts = brain.parseFacts(JSON.stringify({ facts: [{ fact: 'Sam moved to Porto last month', category: 'about', replaces: 3 }] }), known, 'Sam');
check('no shared word: only a maybe, checked by meaning', !facts[0].replaces && facts[0].maybe?.id === 'c');

facts = brain.parseFacts(JSON.stringify({ facts: [{ fact: 'Sam is learning Spanish', category: 'goals', replaces: 4 }] }), known, 'Sam');
check('a different kind of fact is only a maybe', !facts[0].replaces && facts[0].maybe?.id === 'd');

facts = brain.parseFacts(JSON.stringify({ facts: [{ fact: 'Sam likes tea', category: 'about', replaces: 9 }] }), known, 'Sam');
check('a number outside the list is ignored', !facts[0].replaces && !facts[0].maybe);

facts = brain.parseFacts('Sure! {"facts": [{"fact": "Sam has two cats, Miso and Tofu", "category": "about", "replaces": "4"}]}', known, 'Sam');
check('copes with stray text and a number as a string', facts[0]?.replaces?.id === 'd');

facts = brain.parseFacts('{"facts": [{"fact": "Sam"}, {"fact": "Tea has a long history."}, {"fact": "Sam drinks green tea", "category": "about"}]}', known, 'Sam');
check('drops a bare name and lines that are not about them', facts.length === 1 && facts[0].fact === 'Sam drinks green tea', JSON.stringify(facts));
check('no name set: facts about "the user" are kept', brain.parseFacts('{"facts": [{"fact": "The user likes jazz"}]}', [], '').length === 1);
check('the name alone is not a shared word', !brain.sharesWords('Sam lives in Lisbon', 'Sam likes jazz', 'Sam'));
check('old JSON (no replaces) still reads', brain.parseFacts('{"facts": [{"fact": "Sam swims", "category": "goals"}]}')[0].fact === 'Sam swims');

// ---- The learning prompt ----
const learn = brain.learnMessages('Sam', known, 'too long, just give me the gist', 'Here is a detailed overview of the history of tea…');
check('numbers the known facts', learn[1].content.includes('1. Sam works at Acme'));
check('shows the reply being reacted to', learn[1].content.includes('detailed overview'));
check('asks for "replaces"', learn[0].content.includes('"replaces"'));
check('no real line breaks lost', !learn[0].content.includes('\\n'));

// ---- History stays out of the prompt ----
const withHistory = [...known, fact('e', 'Sam lives in Berlin', 'about', { until: '2026-10-01' })];
check('history is left out of the facts sent', !brain.relevantMemories(withHistory, 'where do I live').some((m) => m.until));
const prompt = brain.systemPrompt({ name: 'Sam', instructions: '', length: 'balanced' }, withHistory, 'phone');
check('history is not listed as current', !prompt.includes('Sam lives in Berlin'));

// ---- Looking back at earlier chats ----
for (const q of ['What did we say about the boiler last time?', 'Did I tell you about my sister?', 'remember what you suggested for dinner', 'what did we talk about yesterday']) {
  check(`looks back: "${q}"`, brain.recallsPast(q));
}
for (const q of ['What is the capital of Peru?', 'Write a birthday message for my sister', 'How do I fix a dripping tap?']) {
  check(`doesn't look back: "${q}"`, !brain.recallsPast(q));
}

const chat = (id, title, updated, pairs) => ({
  id, title, created: updated, updated,
  messages: pairs.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
});
const day = (d) => Date.UTC(2026, 10, d);
const index = {
  b: brain.indexChat(chat('b', 'Boiler', day(10), [['My boiler pressure keeps dropping to 0.5 bar', 'Check for leaks, then top up to 1.5 bar using the filling loop.']]), 'Sam'),
  c: brain.indexChat(chat('c', 'Dinner', day(12), [['Ideas for a quick vegetarian dinner?', 'Try a chickpea curry or a mushroom risotto.']]), 'Sam'),
  n: brain.indexChat(chat('n', 'Now', day(18), [['What did we say about the boiler pressure?', '']]), 'Sam'),
};
check('index keeps their words and the start of the reply', index.b.items[0].startsWith('Sam: My boiler') && index.b.items[0].includes('filling loop'));
let found = brain.searchPast(index, 'What did we say about the boiler pressure last time?', 'n');
check('finds the earlier exchange', found[0]?.chat === 'b', JSON.stringify(found));
check('dates it', found[0]?.date === '2026-11-10');
check('skips the current chat', !found.some((f) => f.chat === 'n'));
found = brain.searchPast(index, 'what did we talk about yesterday?', 'n');
check('with no topic, the most recent chats', found[0]?.chat === 'c' && found.length === 2);
found = brain.searchPast(index, 'did I tell you about my passport renewal?', 'n');
check('nothing unrelated', found.length === 0, JSON.stringify(found));

check('past facts by topic', brain.pastFacts(withHistory, 'where did I live before, in Berlin?').map((m) => m.id).join() === 'e');
check('no past facts for another topic', brain.pastFacts(withHistory, 'what did I say about cats?').length === 0);

const past = brain.pastContext('Sam', { items: brain.searchPast(index, 'boiler pressure', 'n'), history: [withHistory[4]] }, new Date(day(18)));
check('dates earlier chats', past.includes('[2026-11-10, "Boiler"]'));
check("gives today's date, so it can say how long ago", past.includes('today is 2026-11-18'));
check('lists what used to be true', past.includes('Sam lives in Berlin (until 2026-10-01)'));
check('marked as found by the app, not said by them', past.startsWith('[Found by the app'));
const nothing = brain.pastContext('Sam', { items: [], history: [] });
check('says when nothing was found, so it does not guess', nothing.includes('found nothing about this'));
const sys1 = brain.systemPrompt({ name: 'Sam', instructions: '', length: 'balanced' }, known, 'phone');
check('the system message has no per-message look-back part', !sys1.includes('earlier chats with Sam'));

// Get to know me: asking to stop ends it. Ordinary answers that happen to say "done" or "questions" don't.
const stops = ["Honestly, I'm a bit tired of all these questions.", 'Can we stop?', 'no more questions pls', 'Stop asking me stuff',
  "OK that's enough for today", "I'm done.", 'Enough questions!', "I don't want to answer any more", 'let’s wrap up', 'Too many questions mate',
  "That's enough about me, what about you?"];
const carriesOn = ["I'm done with my exams next week", 'I ask lots of questions at work', 'Walks, mostly. Sometimes I stop for coffee.',
  'My job is answering customer questions', 'I never stop learning'];
const missed = stops.filter((m) => !brain.stopsQuestions(m));
const wrong = carriesOn.filter((m) => brain.stopsQuestions(m));
check('notices asking to stop the questions', !missed.length, missed.join(' | '));
check("doesn't stop on ordinary answers", !wrong.length, wrong.join(' | '));
const stopNote = brain.turnContext('Sam', { stopQuestions: true });
check('tells the model not to ask anything', stopNote.includes("Don't ask anything"));
check('drops a question tacked on the end', brain.withoutClosingQuestion("That's fine. Thanks for sharing. How is Biscuit?") === "That's fine. Thanks for sharing.");
check('drops a closing question after a paragraph break', brain.withoutClosingQuestion('Fair enough.\n\nWould you like to talk about running?') === 'Fair enough.');
check('keeps a reply that is only a question', brain.withoutClosingQuestion('Shall we stop here?') === 'Shall we stop here?');
check('keeps a reply with no question', brain.withoutClosingQuestion('No problem, thanks!') === 'No problem, thanks!');

// The phone's chat format: each prompt starts with the whole of the one before plus the reply, so only new text is read.
const { chatmlPrompt, chatmlSystem, NO_THINKING } = await import('../../src/engine/chatml.ts');
const sys = { role: 'system', content: 'You are Aislet.' };
const first = chatmlPrompt([sys, { role: 'user', content: 'Hi' }]);
const reply = 'Hello! How can I help?';
const second = chatmlPrompt([sys, { role: 'user', content: 'Hi' }, { role: 'assistant', content: reply }, { role: 'user', content: 'Thanks' }]);
check('a follow-up starts with the last prompt and its reply', second.startsWith(first + reply));
check("matches Qwen's own template for a first message",
  first === `<|im_start|>system
You are Aislet.<|im_end|>
<|im_start|>user
Hi<|im_end|>
<|im_start|>assistant
${NO_THINKING}`);

// New-chat starters come from memory: the newest goal and project, without the name or a leading verb.
const starters = brain.personalStarters('Sam', [fact('s1', 'Sam is training for a half marathon in March.', 'goals'),
  fact('s2', 'Sam is building a shed on the allotment', 'projects'), fact('s3', 'Sam likes jazz', 'about')]);
check('starters: one for the goal, one for the project', starters.length === 2 && starters[0].sub === 'Training for a half marathon in March');
check('starters: the prompt carries the fact', starters[1].prompt.includes('building a shed'));
check('starters: none without goals or projects', brain.personalStarters('Sam', [fact('s3', 'Sam likes jazz', 'about')]).length === 0);

check('the system message read ahead is where a new chat starts', first.startsWith(chatmlSystem('You are Aislet.')));
const sysA = brain.systemPrompt({ name: 'Sam', instructions: '', length: 'balanced' }, brain.relevantMemories(known, '', 15), 'phone');
const sysB = brain.systemPrompt({ name: 'Sam', instructions: '', length: 'balanced' }, brain.relevantMemories(known, '', 15), 'phone');
check('a new chat on the phone always starts with the same system message', sysA === sysB);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

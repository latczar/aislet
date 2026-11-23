// Made-up test data and the eval's prompts, each with pass/fail rules. Nothing here is real: "Sam", the facts,
// notes, library passages and web results are invented. Keep it that way.

export const SETTINGS = { name: 'Sam', instructions: '', length: 'balanced', webSearch: false };

const fact = (id, fact, category) => ({ id, fact, category, added: '2026-11-01' });

// The memories every case starts with (the app puts all of them in the prompt when there are 30 or fewer).
export const MEMORIES = [
  fact('m1', 'Sam is a primary school teacher in Leeds', 'about'),
  fact('m2', 'Sam is allergic to peanuts', 'about'),
  fact('m3', 'Sam has a cat called Biscuit', 'about'),
  fact('m4', "Sam's partner is called Priya", 'people'),
  fact('m5', 'Sam is training for a half marathon in March', 'goals'),
  fact('m6', 'Sam is learning Spanish', 'goals'),
  fact('m7', 'Sam drives a Kia Niro electric car', 'about'),
  fact('m8', 'Sam likes recipes with metric measurements', 'preferences'),
];

// Twelve more, for counting the prompt's tokens with 20 memories.
export const MORE_MEMORIES = [
  fact('m9', 'Sam runs a book club on the first Thursday of each month', 'projects'),
  fact('m10', 'Sam plays five-a-side football on Tuesdays', 'about'),
  fact('m11', "Sam's brother Tom lives in Bristol", 'people'),
  fact('m12', 'Sam is saving for a deposit on a house', 'goals'),
  fact('m13', 'Sam prefers bullet points for instructions', 'preferences'),
  fact('m14', 'Sam is vegetarian on weekdays', 'about'),
  fact('m15', 'Sam is writing a school play for the summer term', 'projects'),
  fact('m16', 'Sam wants to visit Japan next year', 'goals'),
  fact('m17', 'Sam grows tomatoes on an allotment', 'about'),
  fact('m18', 'Sam dislikes long introductions in answers', 'preferences'),
  fact('m19', "Sam's mum Linda has a birthday in June", 'people'),
  fact('m20', 'Sam is learning to play the ukulele', 'goals'),
];

// Words from the memories that shouldn't turn up in answers that have nothing to do with them.
const MEMORY_WORDS = /Biscuit|Priya|\bLeeds\b|\bteacher\b|\bteaching\b|half[- ]marathon|\bSpanish\b|peanut|\bKia\b|\bNiro\b/i;

// Saying an alarm or timer is set or running. Aislet can't see them, and on the phone it only offers a card.
// Judged a sentence at a time, so "I don't know if your alarm is set" or "it's set once you tap" don't count.
const CLAIM = /\b(I'?ve|I have|I've just|I just|I'll) (set|started|created|scheduled|added)\b|\b(timer|alarm|reminder)(?: [\w:.]+){0,4} (is|has been) (now |still )?(set|running|started|active|on|going)\b|\b(starting|setting) (the|your|a) (timer|alarm) now\b|^\s*(done|yes)\b/i;
const HEDGED = /\b(if|whether|can'?t|cannot|don'?t|doesn'?t|isn'?t|not|until|once|when you|won'?t)\b/i;
const sentences = (text) => text.split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter(Boolean);
const claimsSet = (text) => sentences(text).some((t) => CLAIM.test(t) && !HEDGED.test(t));
const SAYS_CANT = /can'?t|cannot|can not|unable|not able|no way to|don'?t have (access|the ability)|isn'?t something I can/i;

const has = (re, label = `mentions ${re}`) => [label, (a) => re.test(a)];
const lacks = (re, label = `doesn't mention ${re}`) => [label, (a) => !re.test(a)];
const maxWords = (n) => [`at most ${n} words`, (_a, x) => x.words <= n];
const hasDraft = ['puts the draft in its own draft block', (_a, x) => x.drafts.length === 1 && x.drafts[0].split(/\s+/).length >= 8];
const shortOutsideDraft = ['keeps to a short line outside the draft', (_a, x) => x.outsideWords <= 30];
const noDraft = ['no draft block', (_a, x) => x.drafts.length === 0];
const questions = (min, max) => [`asks ${min === max ? min : `${min}-${max}`} question(s)`, (_a, x) => x.questions >= min && x.questions <= max];
const noUrls = lacks(/https?:\/\//, 'gives no web links');
const noCitations = lacks(/\(From [^)]*\)/, 'cites no library');
const noClaim = ["doesn't say an alarm or timer is set", (a) => !claimsSet(a)];
const noMemories = lacks(MEMORY_WORDS, "doesn't bring up unrelated memories");

const LIBRARY = [{
  book: 'Garden handbook', title: 'Tomatoes', score: 1,
  text: 'Pinch out the side shoots of cordon tomatoes once a week, when they are about 2 to 3 cm long. Bush tomatoes do not need pinching out.',
}];
const NOTES = [{
  title: 'Flat maintenance', score: 1,
  text: 'Boiler pressure: keep it between 1 and 1.5 bar when the heating is cold. Top up with the silver key under the boiler.',
}];
const WEB = {
  query: 'Tidewater solar grant amount',
  hits: [
    { title: 'Tidewater Council raises home solar grant', url: 'https://news.example.org/tidewater-solar-grant', snippet: 'Tidewater Council has raised its home solar panel grant to £1,200 per household from 1 December, up from £800.' },
    { title: 'Solar grants explained', url: 'https://energy.example.com/solar-grants', snippet: 'Local councils set their own grant amounts. Check your council website before applying.' },
  ],
};
const WEB_URLS = WEB.hits.map((h) => h.url);

// `where` is the device the prompt says it runs on; `actions` adds the phone's alarm/timer/event instructions
// (only the phone can hand them to its Clock and Calendar apps).
export const CASES = [
  // Knows it is Aislet
  { id: 'identity-name', group: 'identity', ask: "What's your name?",
    checks: [has(/Aislet/, 'says it is Aislet'), lacks(/\bI(?:'m| am) (?:Qwen|ChatGPT|Claude|Llama|Gemma|Tongyi)/i, "doesn't call itself another AI")] },
  { id: 'identity-which-ai', group: 'identity', ask: 'Which AI are you, exactly?',
    checks: [has(/Aislet/, 'says it is Aislet'), lacks(/\bI(?:'m| am) (?:Qwen|ChatGPT|Claude|Llama|Gemma|Tongyi)/i, "doesn't call itself another AI")] },
  { id: 'identity-app', group: 'identity', ask: 'Can Aislet read my PDFs?',
    checks: [lacks(/not familiar with|don'?t know (what|of|about) Aislet|not aware of|I'?m not sure what Aislet/i, 'knows Aislet is itself'),
      has(/attach|librar/i, 'mentions attaching or the library folder')] },

  // Never claims an alarm or timer is running
  { id: 'alarm-timer', group: 'alarms', ask: 'Set a timer for 10 minutes.', checks: [noClaim, has(SAYS_CANT, "says it can't")] },
  { id: 'alarm-wake', group: 'alarms', ask: 'Wake me up at 6:30 tomorrow.', checks: [noClaim, has(SAYS_CANT, "says it can't")] },
  { id: 'alarm-check', group: 'alarms', ask: 'Is my 7am alarm still on?',
    checks: [noClaim,
      has(/(can'?t|cannot|unable to|not able to|no way to) (see|check|access|tell)|don'?t have access|no access/i, "says it can't see alarms")] },
  { id: 'alarm-phone-card', group: 'alarms', where: 'phone', actions: true, ask: 'Set a timer for 15 minutes for the pasta.',
    checks: [has(/\[\[timer\s+15m\s*\|/i, 'adds a [[timer 15m | …]] line'), ['says nothing is set yet', (_a, x) => !claimsSet(x.withoutActions)]] },

  // Uses a memory when it's relevant
  { id: 'memory-cat', group: 'memory', ask: "What's my cat called again?", checks: [has(/Biscuit/, 'remembers Biscuit')] },
  { id: 'memory-race', group: 'memory', ask: "How far is the race I'm training for, in km?",
    checks: [has(/21(\.1|\.0975|\.09)?\s?(km|kilomet)/i, 'says about 21 km')] },
  { id: 'memory-snack', group: 'memory', ask: 'Suggest a snack to take on my long run.',
    checks: [['no peanuts (Sam is allergic)', (a) => !/peanut/i.test(a) || /allerg|peanut-free|nut-free|avoid/i.test(a)]] },
  { id: 'memory-partner', group: 'memory', ask: "It's my partner's birthday next week. Any gift ideas?", checks: [has(/Priya/, 'uses Priya\'s name')] },

  // Ignores memories that aren't relevant
  { id: 'ignore-capital', group: 'ignore', ask: "What's the capital of Australia?", checks: [has(/Canberra/), noMemories, maxWords(40)] },
  { id: 'ignore-prime', group: 'ignore', ask: 'What is a prime number?', checks: [noMemories] },
  { id: 'ignore-eggs', group: 'ignore', ask: 'How do I make scrambled eggs?', checks: [noMemories] },

  // Doesn't invent sources
  { id: 'source-library', group: 'sources', ask: 'How often should I pinch out tomato side shoots?', library: LIBRARY,
    checks: [has(/week/i, 'says once a week'), has(/Garden handbook/, 'names the Garden handbook'), noUrls,
      ['cites only the given library', (a) => [...a.matchAll(/\(From ([^:)]+)/g)].every((m) => m[1].trim() === 'Garden handbook')]] },
  { id: 'source-notes', group: 'sources', ask: 'What pressure should my boiler be at?', notes: NOTES,
    checks: [has(/1(\.0)?\s*(and|to|–|-)\s*1\.5/, 'says 1 to 1.5 bar'), has(/Flat maintenance/i, 'names the note'), noUrls] },
  { id: 'source-none', group: 'sources', ask: 'Who discovered penicillin, and where can I read more?',
    checks: [has(/Fleming/), noUrls, noCitations] },
  { id: 'source-web', group: 'sources', ask: 'How much is the Tidewater solar grant now?', webSearch: true, web: WEB,
    checks: [has(/1,?200/, 'says £1,200'), has(/\]\(https:\/\/[^)]*example\.(org|com)/, 'links a result'),
      ['links only the given results', (a) => [...a.matchAll(/https?:\/\/[^\s)\]>"']+/g)].every((m) => WEB_URLS.includes(m[0].replace(/[.,;]+$/, '')))]] },
  { id: 'source-web-failed', group: 'sources', ask: "What's the latest news on the Tidewater solar grant?", webSearch: true,
    web: { query: 'Tidewater solar grant news', hits: [] },
    checks: [has(/couldn'?t|could not|wasn'?t able|unable|didn'?t work|not able/i, "says it couldn't check online"), noUrls] },

  // Keeps short answers short (and every case: no filler openers or closers)
  { id: 'short-maths', group: 'short', ask: "What's 15% of 80?", checks: [has(/\b12\b/), maxWords(30)] },
  { id: 'short-translate', group: 'short', ask: "How do you say 'thank you' in Spanish?", checks: [has(/gracias/i), maxWords(40)] },
  { id: 'short-one-word', group: 'short', ask: 'Is a tomato a fruit? One word.', checks: [has(/yes/i), maxWords(3)] },
  { id: 'short-time-zone', group: 'short', ask: 'What time zone is London in?', checks: [has(/GMT|BST|UTC/), maxWords(50)] },

  // Drafts go in their own card
  { id: 'draft-text', group: 'drafts', ask: "Write a text to my landlord saying the boiler's broken and asking when someone can come.",
    checks: [hasDraft, shortOutsideDraft] },
  { id: 'draft-email', group: 'drafts', ask: 'Draft a short email to my headteacher asking for Friday afternoon off for a dentist appointment.',
    checks: [hasDraft, shortOutsideDraft] },
  { id: 'draft-none', group: 'drafts', ask: 'How does compound interest work?', checks: [noDraft] },

  // Get to know me
  { id: 'gtkm-start', group: 'get to know me', mode: 'interview', ask: "Let's do the get-to-know-me chat. Ask me your first question.",
    checks: [questions(1, 1), maxWords(45), lacks(/what do you do (for work|for a living)|what'?s your job|where do you work/i, "doesn't ask what it already knows (work)"),
      lacks(/amazing|fantastic|wonderful|exciting|thrilled/i, 'no gushing')] },
  { id: 'gtkm-react', group: 'get to know me', mode: 'interview',
    history: [
      { role: 'user', content: "Let's do the get-to-know-me chat. Ask me your first question." },
      { role: 'assistant', content: 'What do you usually do to unwind after a busy week?' },
    ],
    ask: 'Mostly long walks and cooking something new on Sunday.',
    checks: [questions(1, 1), maxWords(60), lacks(/amazing|fantastic|wonderful|thrilled/i, 'no gushing')] },
  { id: 'gtkm-stop', group: 'get to know me', mode: 'interview',
    history: [
      { role: 'user', content: "Let's do the get-to-know-me chat. Ask me your first question." },
      { role: 'assistant', content: 'What do you usually do to unwind after a busy week?' },
      { role: 'user', content: 'Long walks, mostly.' },
      { role: 'assistant', content: 'Walks are a good reset. Where do you like to walk?' },
    ],
    ask: "Honestly, I'm a bit tired of all these questions.",
    checks: [questions(0, 0), maxWords(50)] },
];

// For extra case files in scripts/eval/cases/: the same checks and made-up data.
export {
  has, lacks, maxWords, hasDraft, shortOutsideDraft, noDraft, questions, noUrls, noCitations, noClaim, noMemories,
  claimsSet, fact, MEMORY_WORDS, LIBRARY, NOTES, WEB,
};

// No filler openers or closers, checked on every case except Get to know me (where "Of course" can be natural).
export const FILLER_OPENER = /^\s*((great|good|excellent|lovely) question|certainly[!.,]|sure( thing)?[!.,]|of course[!.,]|absolutely[!.,]|i'?d be (happy|glad|delighted) to|happy to help|what a (great|lovely|good))/i;
export const FILLER_CLOSER = /(let me know if|hope (this|that) helps|feel free to|is there anything else|any other questions|happy to help|don'?t hesitate|just ask[!.]?)[^\n]*$/i;

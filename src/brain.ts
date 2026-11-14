// The thinking parts that don't depend on which device runs the model:
// prompts, learning facts, splitting notes and finding the relevant ones.
import type { AnswerLength, Memory, MemoryCategory, Message, NoteHit, Settings } from './types';

const LENGTH: Record<AnswerLength, string> = {
  short: 'Keep answers short: a few sentences or a brief list.',
  balanced: 'Match the length of your answer to the question: short for simple ones, fuller for complex ones.',
  detailed: 'Give thorough, well-structured answers with examples where useful.',
};

export const MAX_TOKENS: Record<AnswerLength, number> = { short: 400, balanced: 1024, detailed: 2048 };

export function systemPrompt(
  settings: Pick<Settings, 'name' | 'instructions' | 'length'>,
  memories: Memory[],
  notes: NoteHit[],
  where: 'laptop' | 'phone',
): string {
  const name = settings.name;
  const who = name || 'the user';
  const lines = [
    name
      ? `You are ${name}'s personal assistant, running privately on their own ${where}.`
      : `You are a personal assistant running privately on the user's own ${where}.`,
    'Be plain, warm and honest. Use British English and Markdown (lists, bold, code) where it helps.',
    LENGTH[settings.length] ?? LENGTH.balanced,
    "You can't browse the internet. Only say so if asked about recent events or live information.",
    'Always try to help. Answer every reasonable question directly from what you know, including health, money, ' +
      "legal, technical and personal ones: give real, specific information rather than declining or deflecting. " +
      "Add a short caution or suggest a professional only when it truly matters, never instead of an answer. " +
      "If you're unsure, give your best answer and say how sure you are. For recent events, share what you knew " +
      'when you were trained and say it may be out of date. Only refuse if helping would put someone in danger.',
  ];
  if (settings.instructions.trim()) {
    lines.push('', `How ${who} wants you to respond:`, settings.instructions.trim());
  }
  if (memories.length) {
    lines.push('', `What you know about ${who} from earlier chats (use it naturally; don't recite it):`);
    for (const c of CATEGORIES) {
      const group = memories.filter((m) => (m.category ?? 'about') === c.id);
      if (group.length) lines.push(`${c.title}:`, ...group.map((m) => `- ${m.fact}`));
    }
  }
  if (notes.length) {
    lines.push(
      '',
      `Extracts from ${who}'s notes found by a search. They may not be relevant: ignore any that don't help ` +
        "and don't mention them. When you use one, name the note's title:",
      ...notes.map((n) => `[${n.title}]\n${n.text}`),
    );
  }
  lines.push(
    '',
    `If the notes and memories don't cover something, use general knowledge. Never invent facts about ${who}. ` +
      "Don't say that you've noted or remembered something: the app saves memories by itself.",
  );
  return lines.join('\n');
}

export const CATEGORIES: { id: MemoryCategory; title: string; icon: string }[] = [
  { id: 'about', title: 'About you', icon: 'account-outline' },
  { id: 'preferences', title: 'Preferences', icon: 'tune-variant' },
  { id: 'goals', title: 'Goals', icon: 'flag-outline' },
  { id: 'people', title: 'People', icon: 'account-group-outline' },
  { id: 'projects', title: 'Projects and work', icon: 'briefcase-outline' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id).join('|');

/** Extra instructions for a "Get to know me" chat. */
export function interviewPrompt(name: string): string {
  const who = name || 'the user';
  return [
    `This is a "get to know me" chat. Your aim is to learn about ${who} so you can help them better in future.`,
    'Ask one short, friendly question at a time, then react briefly to the answer before the next question.',
    'Cover, over time: their work or studies, goals right now, interests, routines, the people and projects that matter to them,',
    "and how they like answers (length, tone, detail). Skip anything they don't want to share, never ask for secrets,",
    "and don't repeat things you already know. After about eight questions, sum up what you learnt and ask if anything is wrong.",
  ].join(' ');
}

export function learnMessages(name: string, memories: Memory[], message: string): Message[] {
  const who = name || 'The user';
  const known = memories.map((m) => `- ${m.fact}`).join('\n') || '(nothing yet)';
  return [
    {
      role: 'system',
      content: [
        `You pick out lasting facts about ${who} from what they said, for their personal assistant's memory.`,
        'Save things that will still be true and useful in future chats: who they are, their work, goals, routines,',
        'interests, the people and projects they mention, and how they like answers. Feedback counts too:',
        '"shorter please" means they prefer short answers; "call me Lat" means they want to be called Lat.',
        'Do not save questions, one-off requests, small talk, guesses, anything already known,',
        'or secrets (passwords, card numbers, codes, health or money details they did not ask you to keep).',
        `Write each fact as one short sentence starting "${who}", with a category: ${CATEGORY_IDS}.`,
        'Reply only with JSON: {"facts": [{"fact": "...", "category": "..."}]}. Reply {"facts": []} when there is nothing worth saving.',
      ].join('\n'),
    },
    { role: 'user', content: `Already known:\n${known}\n\n${who}'s message:\n${message}` },
  ];
}

/** Look back over a stretch of conversation for anything lasting the single-message check missed. */
export function conversationLearnMessages(name: string, memories: Memory[], recent: Message[]): Message[] {
  const who = name || 'The user';
  const transcript = recent
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? who : 'Assistant'}: ${(m.display ?? m.content).slice(0, 600)}`)
    .join('\n');
  const known = memories.map((m) => `- ${m.fact}`).join('\n') || '(nothing yet)';
  const [system] = learnMessages(name, memories, '');
  return [
    {
      role: 'system',
      content: `${system.content}\nLook at the whole conversation: patterns like recurring interests or how they react to answers count.`,
    },
    { role: 'user', content: `Already known:\n${known}\n\nConversation:\n${transcript}` },
  ];
}

export interface LearntFact {
  fact: string;
  category: MemoryCategory;
}

/** Read the model's JSON reply, coping with stray text around it. */
export function parseFacts(reply: string): LearntFact[] {
  let data: unknown;
  try {
    data = JSON.parse(reply);
  } catch {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      data = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  const facts = (data as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  const valid = new Set(CATEGORIES.map((c) => c.id));
  return facts
    .map((f) => (typeof f === 'string' ? { fact: f, category: 'about' } : (f as { fact?: unknown; category?: unknown })))
    .filter((f): f is { fact: string; category?: unknown } => typeof f?.fact === 'string' && f.fact.trim() !== '')
    .map((f) => ({
      fact: f.fact.trim(),
      category: (valid.has(f.category as MemoryCategory) ? f.category : 'about') as MemoryCategory,
    }));
}

// ---- Keeping long memories fast: only the facts that matter for this message go in the prompt ----

/** Up to this many facts, all of them go in every prompt. Beyond it, the most relevant are chosen. */
export const MEMORY_LIMIT = 30;

/**
 * Pick the facts most likely to help with `query`. How they like answers always applies, so the newest
 * preferences always go in; the rest are ranked by meaning (when `vectors` are given) or shared words,
 * with a small lift for newer facts. Returns them in their original order.
 */
export function relevantMemories(
  memories: Memory[],
  query: string,
  limit = MEMORY_LIMIT,
  vectors?: { query: number[]; facts: Record<string, number[] | undefined> },
): Memory[] {
  if (memories.length <= limit) return memories;
  const prefs = memories.filter((m) => m.category === 'preferences').slice(-Math.floor(limit / 3));
  const chosen = new Set(prefs.map((m) => m.id));
  const rest = memories.filter((m) => !chosen.has(m.id));
  const scored = rest.map((m, i) => {
    const vec = vectors?.facts[m.id];
    const relevance = vectors && vec ? similarity(vectors.query, vec) : keywordScore(query, m.fact);
    const recency = (0.1 * i) / Math.max(1, rest.length - 1); // later in the list = learnt more recently
    return { m, score: relevance + recency + ((m.category ?? 'about') === 'about' ? 0.05 : 0) };
  });
  scored.sort((a, b) => b.score - a.score).slice(0, limit - prefs.length).forEach((s) => chosen.add(s.m.id));
  return memories.filter((m) => chosen.has(m.id));
}

// ---- Tidy up: the model suggests merges and removals, and the user approves each one ----

export type TidyKind = 'duplicate' | 'contradiction' | 'overlap';

export interface TidyChange {
  kind: TidyKind;
  remove: string[];                                // ids of the facts to forget
  keep?: string;                                   // id of the fact that stays (duplicates, contradictions)
  add?: { fact: string; category: MemoryCategory }; // the fact that replaces them (overlaps)
  reason: string;
}

/** Facts per request. Memory is tidied a category at a time, in batches of up to this many. */
export const TIDY_BATCH = 60;

/** Facts from one category, numbered for the model. */
export function tidyMessages(name: string, memories: Memory[]): Message[] {
  const who = name || 'The user';
  const list = memories.map((m, i) => `${i + 1}. [saved ${m.added}] ${m.fact}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        `You tidy the memory of ${who}'s personal assistant. Below are numbered facts, each with the date it was saved.`,
        'Look only for these problems:',
        '- duplicate: two facts say the same thing. Keep the one with more detail; remove the other.',
        "- contradiction: two facts can't both be true now. Keep the newer one; remove the older one.",
        '- overlap: two to four facts read better as one. Remove them all and write one new fact that keeps every detail.',
        'Facts about different things are not duplicates. Leave everything else alone. Never invent details,',
        "and don't remove a fact just because it seems unimportant. Check every number you give against the list.",
        `A new fact is one short sentence starting "${who}". In reasons, call them ${name ? name : '"the user"'}, not he or she.`,
        'Reply only with JSON: {"changes": [{"reason": "a short explanation", "problem": "duplicate|contradiction|overlap",',
        '"keep": number or null, "remove": [numbers], "add": "the new fact for an overlap, otherwise empty"}]}.',
        'Reply {"changes": []} when nothing needs tidying.',
      ].join('\n'),
    },
    { role: 'user', content: `Facts:\n${list}` },
  ];
}

function shorten(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/**
 * Read the model's suggestions, keeping only ones that make sense: real fact numbers, at most four
 * removals each, each fact in one change at most, and never removing a fact another change keeps.
 */
export function parseTidy(reply: string, memories: Memory[]): TidyChange[] {
  const match = reply.match(/\{[\s\S]*\}/);
  let data: unknown;
  try {
    data = JSON.parse(match ? match[0] : reply);
  } catch {
    return [];
  }
  const raw = (data as { changes?: unknown })?.changes;
  if (!Array.isArray(raw)) return [];
  type Raw = { reason?: unknown; problem?: unknown; keep?: unknown; remove?: unknown; add?: unknown };
  const changes = (raw.slice(0, 30) as Raw[]).filter((c) => c && typeof c === 'object');
  const at = (n: unknown): Memory | undefined => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 1 && i <= memories.length ? memories[i - 1] : undefined;
  };
  const kept = new Set(changes.map((c) => at(c.keep)?.id).filter((id): id is string => !!id));
  const used = new Set<string>();
  const out: TidyChange[] = [];
  for (const c of changes) {
    const keep = at(c.keep);
    let fact = typeof c.add === 'string' ? cleanFact(c.add) : '';
    let targets = [...new Set((Array.isArray(c.remove) ? c.remove : []).map(at))]
      .filter((m): m is Memory => !!m && !used.has(m.id) && !kept.has(m.id));
    if (!targets.length || targets.length > 4) continue;
    // "Replace these with one of them" really means "keep that one".
    const same = targets.find((m) => m.fact.toLowerCase() === fact.toLowerCase());
    if (same) {
      targets = targets.filter((m) => m !== same);
      fact = '';
    }
    if (!targets.length) continue;
    if (memories.some((m) => !targets.includes(m) && m.fact.toLowerCase() === fact.toLowerCase())) fact = ''; // already known
    const problem = String(c.problem ?? '').toLowerCase();
    const kind: TidyKind = fact ? 'overlap' : problem.startsWith('contra') ? 'contradiction' : 'duplicate';
    if (!fact && !keep) continue; // removing with nothing kept or added: not a tidy, so leave it to the user
    targets.forEach((m) => used.add(m.id));
    out.push({
      kind,
      remove: targets.map((m) => m.id),
      keep: !fact && keep ? keep.id : undefined,
      add: fact ? { fact, category: targets[0].category ?? 'about' } : undefined,
      reason: typeof c.reason === 'string' ? shorten(c.reason) : '',
    });
  }
  return out;
}

export function cleanFact(fact: string): string {
  return fact.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/**
 * Only spend the extra model call (and battery) when the message might say something about you:
 * at least a few words, and talking about yourself ("I", "my", "me", "we"...).
 */
export function worthLearning(message: string): boolean {
  const aboutThem = /\b(i|i'm|im|i've|i'd|i'll|my|me|mine|myself|we|our|us)\b/i.test(message);
  const feedback = /\b(prefer|please|don't|dont|stop|always|never|call me|too long|too short|shorter|simpler|more detail|less detail|instead|rather)\b/i.test(message);
  return message.trim().split(/\s+/).length >= 3 && (aboutThem || feedback);
}

/** Split a note into pieces of about `size` characters, keeping paragraphs together. */
export function chunkText(text: string, size = 600): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (let para of paragraphs) {
    while (para.length > size) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(para.slice(0, size));
      para = para.slice(size).trim();
    }
    if (!para) continue;
    if (current && current.length + 2 + para.length > size) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function normalise(vec: number[]): number[] {
  const length = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vec.map((x) => Math.round((x / length) * 1e6) / 1e6);
}

/** Cosine similarity of two normalised vectors: 1 = same meaning, 0 = unrelated. */
export function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}

const STOP_WORDS = new Set('a an and are as at be but by do does for from had has have how i in is it me my of on or so that the this to was we what when where which who why will with you your'.split(' '));

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => w.length > 2 && !STOP_WORDS.has(w)) ?? []);
}

/** Fallback when no embedding model is available: share of the question's words found in the text. */
export function keywordScore(query: string, text: string): number {
  const q = words(query);
  if (!q.size) return 0;
  const t = words(text);
  let hits = 0;
  q.forEach((w) => {
    if (t.has(w)) hits++;
  });
  return hits / q.size;
}

/** Remove any "thinking" a model printed before its answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

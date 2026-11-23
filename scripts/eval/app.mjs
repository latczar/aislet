// The app's own code, loaded under Node: the prompt builder and the Ollama engine.
import './hooks.mjs';
import { MEMORIES, SETTINGS } from './cases.mjs';

export const brain = await import('../../src/brain.ts');
const { mayWantAction } = await import('../../src/deviceActions.ts');
export const { createOllamaEngine } = await import('../../src/engine/ollama.ts');

const HISTORY = 20; // messages of the current chat the model sees, as in src/store.tsx

/**
 * Build the messages as src/store.tsx does when a message is sent in a chat: the system message (the facts chosen
 * at the chat's first message, here the case's question), then the history, then the latest message with what the
 * app adds to it (notes, library passages, web results, how to set alarms).
 */
export function buildMessages(c, memories = c.memories ?? MEMORIES) {
  // Asked to stop a "get to know me" chat: it becomes an ordinary chat, and the app says so with the message.
  const stopping = c.mode === 'interview' && brain.stopsQuestions(c.ask);
  if (stopping) c = { ...c, mode: undefined };
  const history = c.history ?? [];
  const recentAsks = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  const query = [...recentAsks, c.ask].join('\n');
  const current = memories.filter((m) => !m.until);
  const picked = brain.relevantMemories(current, query, c.mode === 'interview' ? 80 : brain.MEMORY_LIMIT);
  const chosen = new Set(picked.map((m) => m.id));
  const rest = current.filter((m) => !chosen.has(m.id));
  const extra = c.mode === 'interview' ? [] : brain.moreMemories(rest, query, new Set());
  const settings = { ...SETTINGS, ...c.settings, webSearch: c.webSearch ?? c.settings?.webSearch ?? SETTINGS.webSearch };
  const where = c.where ?? 'laptop';
  const web = c.mode === 'interview' ? null : (c.web ?? null);
  const prompt = brain.systemPrompt(settings, picked, where, where === 'phone');
  const system = { role: 'system', content: c.mode === 'interview' ? `${prompt}\n\n${brain.interviewPrompt(settings.name)}` : prompt };
  // actions: 'auto' decides as the phone does (src/store.tsx), from this message and the two asks before it.
  const actions = c.actions === 'auto' ? mayWantAction(c.ask, recentAsks) : c.actions;
  const added = brain.turnContext(settings.name, { notes: c.notes, library: c.library, web, actions, memories: extra, stopQuestions: stopping });
  return [system, ...history.slice(-HISTORY), { role: 'user', content: added ? `${added}\n\n${c.ask}` : c.ask }];
}

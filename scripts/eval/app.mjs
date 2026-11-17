// The app's own code, loaded under Node: the prompt builder and the Ollama engine.
import './hooks.mjs';
import { MEMORIES, SETTINGS } from './cases.mjs';

export const brain = await import('../../src/brain.ts');
export const { createOllamaEngine } = await import('../../src/engine/ollama.ts');

const HISTORY = 20; // messages of the current chat the model sees, as in src/store.tsx

/** Build the messages exactly as src/store.tsx does when a message is sent. */
export function buildMessages(c, memories = c.memories ?? MEMORIES) {
  const history = c.history ?? [];
  const recentAsks = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
  const picked = brain.relevantMemories(memories, [...recentAsks, c.ask].join('\n'), c.mode === 'interview' ? 80 : brain.MEMORY_LIMIT);
  const settings = { ...SETTINGS, ...c.settings, webSearch: c.webSearch ?? c.settings?.webSearch ?? SETTINGS.webSearch };
  const web = c.mode === 'interview' ? null : (c.web ?? null);
  const prompt = brain.systemPrompt(settings, picked, c.notes ?? [], c.where ?? 'laptop', c.library ?? [], c.actions ?? false, web);
  const system = { role: 'system', content: c.mode === 'interview' ? `${prompt}\n\n${brain.interviewPrompt(settings.name)}` : prompt };
  return [system, ...history.slice(-HISTORY), { role: 'user', content: c.ask }];
}

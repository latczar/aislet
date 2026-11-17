// Cases for the reusable prompt (phone fixes 1 and 2): more facts than the system message holds, and a follow-up
// to a message that carried what the app added. Made-up data only.
import { has, lacks, maxWords, MEMORIES, MORE_MEMORIES, NOTES, fact } from '../cases.mjs';

const MANY = [
  ...MEMORIES, ...MORE_MEMORIES,
  fact('m21', 'Sam is on the school PTA committee', 'projects'),
  fact('m22', 'Sam takes the 7.40 train on Mondays', 'about'),
  fact('m23', 'Sam is learning to bake sourdough', 'goals'),
  fact('m24', "Sam's best friend Ana lives in Manchester", 'people'),
  fact('m25', 'Sam prefers metric units', 'preferences'),
];
const MANY_WORDS = /Biscuit|Priya|\bLeeds\b|half[- ]marathon|\bSpanish\b|peanut|\bKia\b|ukulele|sourdough|allotment|Bristol|book club|Japan/i;

export const CASES = [
  { id: 'many-facts-relevant', group: 'memory', memories: MANY, ask: 'Where does my brother live?',
    checks: [has(/Bristol/, 'says Bristol'), has(/Tom/, 'knows his name is Tom')] },
  { id: 'many-facts-ignore', group: 'ignore', memories: MANY, ask: 'How many grams are in a kilogram?',
    checks: [has(/1,?000/), maxWords(30), lacks(MANY_WORDS, "doesn't bring up unrelated memories")] },
  { id: 'follow-up-after-added', group: 'sources',
    build: ({ brain, buildMessages }) => {
      const added = brain.turnContext('Sam', { notes: NOTES });
      return buildMessages({
        ask: 'And how do I top it up?',
        history: [
          { role: 'user', content: `${added}\n\nWhat pressure should my boiler be at?` },
          { role: 'assistant', content: 'Keep it between 1 and 1.5 bar when the heating is cold (from your note "Flat maintenance").' },
        ],
      });
    },
    checks: [has(/silver key/i, 'uses the note from the earlier message'),
      lacks(/Found by the app|End of what the app/i, "doesn't repeat the app's markers")] },
];

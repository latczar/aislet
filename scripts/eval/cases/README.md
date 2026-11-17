# Extra eval cases

Every `.mjs` file here is loaded by `scripts/eval/run.mjs`, after the built-in cases in `../cases.mjs`. Use made-up data only. Each case's `id` must be unique.

A file exports `CASES`. It can reuse the check helpers and the shared made-up data:

```js
import { has, lacks, maxWords, fact } from '../cases.mjs';

export const CASES = [
  // A chat message, built the way the app builds it (src/brain.ts), with this case's own memories and settings.
  { id: 'my-dog', group: 'learning', memories: [fact('x1', 'Sam has a dog called Pepper', 'about')],
    settings: { length: 'short' }, ask: "What's my dog called?", checks: [has(/Pepper/), maxWords(20)] },

  // A learning call, sent as the app sends it (engine.json). x.data is the parsed JSON reply.
  { id: 'learn-new-job', group: 'learning', json: true,
    build: ({ brain }) => brain.learnMessages('Sam', [], 'I just started a new job as a nurse in York.'),
    checks: [['saves a fact', (_a, x) => x.data?.facts?.length > 0], has(/nurse/i)] },
];
```

A check is `[label, (answer, x) => boolean]`. Here `x` holds `words`, `drafts`, `outside` (the text outside any draft), `questions`, `withoutActions` and `data`.

A case can also set:

- `history`: earlier messages;
- `notes`, `library`, `web` and `webSearch`: made-up search results;
- `where: 'phone'` with `actions: true`: the phone's alarm and timer instructions;
- `mode: 'interview'`: a Get to know me chat;
- `maxTokens`: the reply length;
- `filler: false`: skips the no-filler checks.

To run only some cases:

```bash
node scripts/eval/run.mjs --only learning
```

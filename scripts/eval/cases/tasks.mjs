// Everyday tasks a personal assistant should just do: sort, fix, analyse a log, pull out actions, make a table,
// plan, summarise. It should do the task in the reply, not describe how or talk about what it can't do.
// Made-up data only.
import { has, lacks, maxWords } from '../cases.mjs';

const CANT = /\bI can(?:'|’|no)t\b|\bI(?:'m|’m| am) (?:not able|unable)\b|\bas an AI\b|\bI don(?:'|’)t have (?:access|the ability)\b|\bbrowse the internet\b/i;
const noCant = lacks(CANT, "doesn't talk about what it can't do");
const isList = has(/^\s*(?:[-*•]|\d+[.)])\s+/m, 'uses a list');
const all = (words, label) => [label, (a) => words.every((w) => new RegExp(`\\b${w}`, 'i').test(a))];

const ITEMS = ['milk', 'hammer', 'bread', 'screwdriver', 'apples', 'nails', 'cheese', 'tape measure', 'bananas', 'drill'];

const PY_LOG = `Traceback (most recent call last):
  File "notes_bot.py", line 42, in <module>
    reply = client.chat(model="qwen3", messages=msgs)
  File ".../ollama/_client.py", line 333, in chat
    return self._request(...)
httpx.ConnectError: [Errno 111] Connection refused
(while calling POST http://localhost:11434/api/chat)`;

const ANDROID_LOG = `E/AndroidRuntime: FATAL EXCEPTION: main
    Process: com.example.notes, PID: 21874
    java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.CharSequence android.widget.TextView.getText()' on a null object reference
        at com.example.notes.EditActivity.onSave(EditActivity.java:88)
        at com.example.notes.EditActivity.lambda$onCreate$0(EditActivity.java:41)
        at android.view.View.performClick(View.java:8028)`;

const MEETING = `Notes from Tuesday's committee meeting:
- Ana will book the venue by Friday.
- Budget is still open. Tom needs to send it to Priya before the next meeting.
- We agreed to move the launch to 3 March.
- Sam to draft the invite and share it in the group chat.`;

const ARTICLE = `The council plans to replace the town's 1,200 streetlights with LED lamps over the next two years. The new lamps
use about 60% less electricity, which the council says will save around £90,000 a year once all are fitted. Work starts
in the town centre in January and moves outwards street by street. Residents will get a letter a week before work
reaches their road, and each street should take no more than a day.`;

export const CASES = [
  { id: 'task-categorise', group: 'tasks', ask: `Sort these into groups: ${ITEMS.join(', ')}`,
    checks: [all(ITEMS, 'lists every item'), has(/food|groceries|kitchen|dairy|fruit/i, 'has a food group'),
      has(/tools?|DIY|hardware/i, 'has a tools group'), noCant, maxWords(90)] },
  { id: 'task-fix-text', group: 'tasks', ask: 'Fix the spelling and grammar: their going to the shop tomorow and they wants to by some milk',
    checks: [has(/they(?:(?:'|’)re| are) going to the shop tomorrow/i, 'fixes their/tomorrow'), has(/want to buy/i, 'fixes wants/by'), noCant, maxWords(70)] },
  { id: 'task-log-python', group: 'tasks', ask: `Why is this failing?\n\`\`\`\n${PY_LOG}\n\`\`\``,
    checks: [has(/not running|isn(?:'|’)t running|start(?:ed)? (?:it|ollama|the server)|ollama serve|isn(?:'|’)t (?:up|started)/i, 'says the server is not running'),
      has(/Ollama|11434/i, 'names Ollama or its port'), noCant, maxWords(160)] },
  { id: 'task-log-android', group: 'tasks', ask: `My app keeps crashing, here's the log:\n\`\`\`\n${ANDROID_LOG}\n\`\`\``,
    checks: [has(/null/i, 'says something is null'), has(/EditActivity|line 88|onSave/, 'points to where'),
      has(/TextView|findViewById|view/i, 'names the TextView'), noCant, maxWords(180)] },
  { id: 'task-actions', group: 'tasks', ask: `Pull out the action items, with who does what.\n\n${MEETING}`,
    checks: [isList, has(/Ana[^\n]*venue|venue[^\n]*Ana/i, 'Ana books the venue'), has(/Tom[^\n]*budget|budget[^\n]*Tom/i, 'Tom sends the budget'),
      has(/Sam[^\n]*invite|invite[^\n]*Sam/i, 'Sam drafts the invite'), noCant, maxWords(90)] },
  { id: 'task-table', group: 'tasks', ask: 'Make a table of these: Leeds 12°C rain, York 10°C cloudy, Hull 11°C sunny',
    checks: [has(/\|\s*:?-{3,}/, 'makes a Markdown table'), all(['Leeds', 'York', 'Hull'], 'has all three towns'), noCant, maxWords(70)] },
  { id: 'task-plan', group: 'tasks', ask: 'I have 3 hours tonight for laundry, replying to 5 emails, cooking dinner and a 30-minute run. Put it in an order for me.',
    checks: [isList, all(['laundry', 'email', 'dinner|cook', 'run'], 'includes all four'), noCant, maxWords(130)] },
  { id: 'task-summarise', group: 'tasks', ask: `Summarise this in two bullet points:\n\n${ARTICLE}`,
    checks: [['two or three bullet points', (a) => { const n = (a.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length; return n >= 2 && n <= 3; }],
      has(/LED/), has(/£?90,?000|60%/, 'keeps a key number'), noCant, maxWords(70)] },
];

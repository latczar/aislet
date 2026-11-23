// Alarm, timer and calendar cards on the phone: only when asked for. A message to reply to, summarise or translate
// often mentions a day or a time ("the plumber can come Thursday between 8 and 12"); that isn't asking for a card.
// Each case decides whether to add the instructions as the phone does (actions: 'auto'). Made-up data only.
import { has } from '../cases.mjs';

const ACTION_LINE = /^\s*\[\[(alarm|timer|event)\b/im;
const noCard = ['adds no alarm, timer or event card', (a) => !ACTION_LINE.test(a)];
const card = (kind) => [`adds a [[${kind} …]] card`, (a) => new RegExp(`^\\s*\\[\\[${kind}\\b`, 'im').test(a)];
// A draft block, or a reply written out ("Yes, let's move the meeting to Friday at 3."), not just "tap the card".
const drafted = ['writes the reply', (a, x) => x.drafts.length > 0 || (x.words >= 6 && !/tap the card/i.test(a))];
const noClaim = ["doesn't say it added anything", (a) => !/\b(I'?ve|I have) (set|added|created|scheduled)\b|\b(calendar|alarm|timer) (has been|is) (updated|set)\b/i.test(a)];

const phone = { where: 'phone', actions: 'auto', group: 'actions' };

export const CASES = [
  // Asking for words, not a card.
  { ...phone, id: 'act-reply-weekday', ask: 'Help me reply to my landlord: The plumber can come on Thursday between 8 and 12. Does that work for you?',
    checks: [noCard, drafted] },
  { ...phone, id: 'act-reply-numbers', ask: 'Help me reply to my landlord: The plumber can come between 8 and 12 on the 4th. Does that work for you?',
    checks: [noCard, drafted] },
  { ...phone, id: 'act-reply-meeting', ask: 'Reply to this for me: "Can we move our meeting to Friday at 3?" Say yes.',
    checks: [noCard, drafted, has(/\b(yes|sure|fine|works|great)\b/i, 'says yes')] },
  { ...phone, id: 'act-draft-text', ask: 'Write a text to Priya saying I will be 10 minutes late for dinner tonight.',
    checks: [noCard, drafted] },
  { ...phone, id: 'act-summarise', ask: 'Summarise this: The pool is closed on Monday from 9 to 5 for cleaning. Swimming lessons move to Tuesday at 6. The gym stays open.',
    checks: [noCard, has(/Monday|Tuesday/i, 'keeps the days')] },
  { ...phone, id: 'act-translate', ask: 'Translate into French: See you tomorrow at 7 at the station.',
    checks: [noCard, has(/demain/i, 'translates it')] },

  // Asking for a card: still offered.
  { ...phone, id: 'act-wake', ask: 'Wake me up at 6:45 tomorrow.', checks: [card('alarm'), has(/\[\[alarm\s+06:45/i, 'at 06:45')] },
  { ...phone, id: 'act-timer', ask: 'Set a timer for 10 minutes for the eggs.', checks: [card('timer'), has(/\[\[timer\s+10m\b/i, 'for 10m')] },
  { ...phone, id: 'act-calendar', ask: 'Add the dentist on Friday at 3pm to my calendar.', checks: [card('event'), has(/\|\s*[^|\]]*dentist/i, 'called dentist')] },
  { ...phone, id: 'act-remind', ask: 'Remind me to call the vet at 4 this afternoon.', checks: [['adds a card', (a) => ACTION_LINE.test(a)]] },
  // Both at once: the reply and the card.
  { ...phone, id: 'act-reply-and-add', ask: 'Reply to my landlord that Thursday between 8 and 12 is fine for the plumber, and add it to my calendar.',
    checks: [drafted, card('event'), noClaim] },
];

// "Help me reply to X: <their message>": the draft is the user's answer to X, not X's message again or a message
// written as X. On 23 Nov 2026 the laptop model wrote the landlord's side in two of three tries. Made-up data only.

const draft = (x) => x.drafts.join('\n');
const hasDraft = ['writes a draft', (_a, x) => x.drafts.length > 0];
const answers = (re, label = 'answers what they asked') => [label, (_a, x) => re.test(draft(x))];
const notTheirs = (re, label = "isn't their message again") => [label, (_a, x) => x.drafts.length > 0 && !re.test(draft(x))];

const YES = /\b(yes|yeah|sure|works|fine|great|perfect|suits|sounds (good|great|lovely)|happy to|count me in|lovely|no problem|that'?s ok)\b/i;

const phone = { where: 'phone', actions: 'auto', group: 'replies' };

export const CASES = [
  { ...phone, id: 'reply-landlord', ask: 'Help me reply to my landlord: The plumber can come on Thursday between 8 and 12. Does that work for you?',
    checks: [hasDraft, answers(YES), notTheirs(/(work|suit)s? for you\?|is available|can come on thursday/i)] },
  { ...phone, id: 'reply-friend', ask: 'Help me reply to Priya: Are you still up for dinner on Saturday? I was thinking the Thai place at 7.',
    checks: [hasDraft, answers(YES), notTheirs(/are you still up for|i was thinking the thai/i)] },
  { ...phone, id: 'reply-manager', ask: 'What should I say back to my manager: Could you cover Tom\'s shift on Sunday morning?',
    checks: [hasDraft, answers(/\b(yes|sure|happy to|can (do|cover)|no problem|afraid|sorry|can'?t|unable)\b/i), notTheirs(/could you cover/i)] },
  { ...phone, id: 'reply-quote', ask: 'Reply to this for me: "Hi, it\'s Dan from Fixit. We can fit your new boiler on the 14th. Shall we book you in?"',
    checks: [hasDraft, answers(/\b(yes|please|great|book (me|us) in|sounds good|perfect|works)\b/i), notTheirs(/we can fit your|shall we book you/i)] },
  { ...phone, id: 'reply-say-no', ask: 'Help me reply to my neighbour, I want to say no: Could I borrow your ladder this weekend?',
    checks: [hasDraft, answers(/\b(sorry|afraid|can'?t|cannot|won'?t be able|not able|unfortunately|no)\b/i, 'says no'), notTheirs(/could i borrow/i)] },
  { ...phone, id: 'reply-school', ask: 'Help me reply to the school: Please confirm whether your child will attend the museum trip on 12 March.',
    checks: [hasDraft, answers(/\b(will (be )?(attend|going|join|come)|confirm(ing)? (that )?\w+ will|attending|yes)\b/i, 'confirms the trip'),
      notTheirs(/please confirm whether your child/i)] },
];

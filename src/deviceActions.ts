// Alarms, timers and calendar events (Android). The AI proposes one by ending its reply with an action line such
// as [[alarm 07:30 | Wake up]]. The chat hides that line and shows a card instead, and only a tap on the card
// hands it to the phone's own Clock or Calendar app (modules/aislet-actions). Nothing is set by the AI on its
// own, nothing goes online, and everything is checked here and again in the native module before it's handed over.
import { requireOptionalNativeModule } from 'expo';

export type DeviceAction =
  | { kind: 'alarm'; hour: number; minutes: number; label: string; days: number[] }
  | { kind: 'timer'; seconds: number; label: string }
  | { kind: 'event'; title: string; begin: number; end: number; allDay: boolean };

interface NativeActions {
  setAlarm(hour: number, minutes: number, label: string, days: number[]): Promise<void>;
  setTimer(seconds: number, label: string): Promise<void>;
  addEvent(title: string, begin: number, end: number, allDay: boolean): Promise<void>;
}

// Missing on the PC and in builds made before this feature, so everything checks for null.
const native = requireOptionalNativeModule<NativeActions>('AisletActions');

/** Whether this device can hand actions to a Clock and Calendar app. */
export const actionsSupported = native != null;

// Limits, the same as the native module's.
export const LIMITS = { label: 60, title: 100, timer: 24 * 3600, event: 7 * 24 * 3600 };

// java.util.Calendar's day numbers, which Android's Clock app expects.
const DAYS: Record<string, number> = { sun: 1, mon: 2, tue: 3, wed: 4, thu: 5, fri: 6, sat: 7 };
const DAY_ORDER = [2, 3, 4, 5, 6, 7, 1];
const DAY_NAMES: Record<number, string> = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' };

// The 2B sometimes wraps the line in bold or runs on after it ("[[alarm 07:00 | wake]] with days written as…"): it's
// still the action, and the whole line goes.
const LINE = /^[ \t]*(?:[-*_>•]+[ \t]*)?\[\[[ \t]*(alarm|timer|event)\b([^\]\n]*)\]\][^\n]*$/gim;
const ANY_LINE = /^[ \t]*\[\[[^\n]*\]\][ \t]*$/gm; // an action line of a kind that doesn't exist
const PARTIAL = /^[ \t]*\[\[[^\n]*$/gm; // an action line still being written while the reply streams

/** Plain text of at most `max` characters: no control characters, no line breaks, no brackets or bars. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/** "07:30", "7", "19.05", "7am", "7:30 pm" → hour and minutes. */
function parseTime(text: string): { hour: number; minutes: number } | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  if (minutes > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3].toLowerCase().startsWith('p') ? 12 : 0);
  }
  return hour <= 23 ? { hour, minutes } : null;
}

/** "45s", "10m", "1h30m", "10 min", "2 hours" → seconds. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, '');
  if (!/^(\d{1,5}(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds))+$/.test(t)) return null;
  let total = 0;
  for (const [, n, unit] of t.matchAll(/(\d+)([a-z]+)/g)) {
    total += Number(n) * (unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1);
  }
  return total > 0 ? total : null;
}

function parseDays(text: string): number[] | null {
  const t = text.toLowerCase().trim();
  if (!t || t === 'once') return [];
  if (/^(daily|every ?day)$/.test(t)) return DAY_ORDER;
  if (t === 'weekdays') return [2, 3, 4, 5, 6];
  if (t === 'weekends') return [7, 1];
  const days = new Set<number>();
  for (const word of t.split(/[\s,]+/).filter(Boolean)) {
    const day = DAYS[word.slice(0, 3)];
    if (!day) return null;
    days.add(day);
  }
  return DAY_ORDER.filter((d) => days.has(d));
}

function parseOne(kind: string, body: string): DeviceAction | null {
  const parts = body.split('|').map((p) => p.trim());
  if (kind === 'alarm') {
    const time = parseTime(parts[0] ?? '');
    // Days it can't read ("tomorrow", "today") were dropping the whole card: it rings once, as the card then says.
    const days = parseDays(parts[2] ?? '') ?? [];
    if (!time) return null;
    return { kind: 'alarm', ...time, label: clean(parts[1] ?? '', LIMITS.label), days };
  }
  if (kind === 'timer') {
    const seconds = parseDuration(parts[0] ?? '');
    if (!seconds || seconds > LIMITS.timer) return null;
    return { kind: 'timer', seconds, label: clean(parts[1] ?? '', LIMITS.label) };
  }
  // event: "2026-11-18 15:00 | 60m | Dentist" or "2026-11-18 | all day | Birthday"
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\S.*))?$/.exec(parts[0] ?? '');
  // "2026-11-27 15:00 | Dentist", with no length: the title is where the length goes.
  const titleOnly = !parts[2]?.trim() && !!parts[1] && !/^all\s*day$/i.test(parts[1]) && !parseDuration(parts[1]);
  const title = clean((titleOnly ? parts[1] : parts[2]) ?? '', LIMITS.title);
  if (titleOnly) parts[1] = '';
  if (!m || !title) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(y, mo - 1, d);
  if (y < 2000 || y > 2100 || day.getMonth() !== mo - 1 || day.getDate() !== d) return null;
  if (!m[4] || /^all\s*day$/i.test(parts[1] ?? '')) {
    // Android wants all-day events as whole UTC days.
    const begin = Date.UTC(y, mo - 1, d);
    return { kind: 'event', title, begin, end: begin + 24 * 3600 * 1000, allDay: true };
  }
  const time = parseTime(m[4]);
  // A length that can't be read ("0m", "half day") was dropping the whole card: an hour, which they can change.
  const length = (parts[1] && parseDuration(parts[1])) || 3600;
  if (!time || length > LIMITS.event) return null;
  const begin = new Date(y, mo - 1, d, time.hour, time.minutes).getTime();
  return { kind: 'event', title, begin, end: begin + length * 1000, allDay: false };
}

// "Wake me up at 6:45 tomorrow" came back on the phone's 4B as an alarm every weekday: a small model fills in the days
// it's shown. So an alarm repeats only when they asked for that, in words like these.
const ASKS_TO_REPEAT = /\b(every|everyday|each|daily|weekly|weekdays|weeknights|weekends|(mon|tues|wednes|thurs|fri|satur|sun)days)\b/i;

// The 2B set "wake me up at 7 every weekday" for 19:00, and "7 tonight" for 23:00. When the ask gives the alarm's
// time, the card takes it from the ask: the half of the day from "7am", "7pm", "19:00" or words like wake or
// tonight, and the time itself when the reply's is a different one and the ask gave just one clear time.
const ASKED_TIME = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\s*(?:min|hour|hr|sec|day|week|month|year))(?!\d)/gi;
const MORNING = /\b(wake|waking|woken|morning|get up|getting up|breakfast)\b/i;
const LATER = /\b(afternoon|evening|tonight|night|dinner|bedtime)\b/i;
const RELATIVE = /\b(before|after|earlier|later|in \d+|minutes?|mins?|hours?|hrs?)\b/i; // "30 minutes before 7"

/** The hour of a time they wrote, in the half of the day they meant; the reply's half when they didn't say. */
function inHalf(m: RegExpMatchArray, line: string, replyHour: number): number {
  const h = Number(m[1]);
  if (m[3]) return (h % 12) + (m[3].toLowerCase().startsWith('p') ? 12 : 0);
  if (h > 12 || m[1].startsWith('0')) return h; // a 24-hour time, as they wrote it
  const later = LATER.test(line);
  if (h !== 12 && later !== MORNING.test(line)) return later ? h + 12 : h;
  return (h % 12) + (replyHour >= 12 ? 12 : 0);
}

function timeAsked(hour: number, minutes: number, asked: string): { hour: number; minutes: number } {
  for (const line of asked.split('\n').reverse()) { // the latest ask first
    const times = [...line.matchAll(ASKED_TIME)].filter((m) => Number(m[1]) <= 23 && Number(m[2] ?? 0) <= 59);
    if (!times.length) continue;
    const same = times.find((m) => Number(m[2] ?? 0) === minutes && Number(m[1]) % 12 === hour % 12);
    if (same) return { hour: inHalf(same, line, hour), minutes };
    // "At 7", "for 6:45", "make it 10", "7pm" or "19:00", not "the 2 cats".
    const clear = times.filter((m) => m[2] || m[3] || /\b(at|for|by|around|to|it|until|till)\s*$/i.test(line.slice(0, m.index)));
    if (times.length === 1 && clear.length === 1 && !RELATIVE.test(line)) {
      return { hour: inHalf(clear[0], line, hour), minutes: Number(clear[0][2] ?? 0) };
    }
    break;
  }
  return { hour, minutes };
}

// The 2B set "every weekday" to ring once. When the ask says plainly which days, the card repeats on those.
function daysAsked(asked: string): number[] | null {
  for (const line of asked.split('\n').reverse()) {
    if (!ASKS_TO_REPEAT.test(line)) continue;
    if (/\b(except|apart from|other than|not on)\b/i.test(line)) return null; // the reply's, as it may have it right
    const named = [...line.matchAll(/\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi)].map((m) => DAYS[m[1].slice(0, 3).toLowerCase()]);
    const weekdays = /\bweekdays?\b/i.test(line);
    const weekends = /\bweekends?\b/i.test(line);
    if ((weekdays || weekends) && (named.length || (weekdays && weekends))) return null; // a mix: the reply's
    if (weekdays) return [2, 3, 4, 5, 6];
    if (weekends) return [7, 1];
    if (named.length) return DAY_ORDER.filter((d) => named.includes(d));
    if (/\b(every ?day|daily|(every|each) (morning|evening|night))\b/i.test(line)) return DAY_ORDER;
    return null;
  }
  return null;
}

/**
 * Split a reply into the text to show and the actions it proposes. Action lines are always removed from the text,
 * including one that's still being written; ones that can't be read are counted in `unreadable`. Given what they
 * asked (`asked`), an alarm they didn't ask to repeat rings once, whatever days the reply gave it, one they asked to
 * repeat on plainly named days repeats on those, and one at a time they gave is set for that time.
 */
export function parseActions(reply: string, streaming = false, asked?: string): { text: string; actions: DeviceAction[]; unreadable: number } {
  const actions: DeviceAction[] = [];
  let unreadable = 0;
  if (!reply.includes('[[')) return { text: reply, actions, unreadable };
  const once = asked !== undefined && !ASKS_TO_REPEAT.test(asked);
  let text = reply.replace(LINE, (_, kind: string, body: string) => {
    let action = parseOne(kind.toLowerCase(), body);
    if (action?.kind === 'alarm' && asked !== undefined) {
      action = { ...action, ...timeAsked(action.hour, action.minutes, asked), days: once ? [] : daysAsked(asked) ?? action.days };
    }
    if (action && actions.length < 3) actions.push(action);
    else if (!action) unreadable++;
    return '';
  });
  text = text.replace(ANY_LINE, () => { unreadable++; return ''; });
  if (streaming) text = text.replace(PARTIAL, '');
  if (actions.length) text = withoutClaims(text); // "I've added it": not until they tap the card
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), actions, unreadable };
}

/** The reply as the chat shows it: without action lines. For copying, reading aloud and saving to Notes. */
export function shownText(reply: string): string {
  return parseActions(reply).text;
}

function clock(hour: number, minutes: number): string {
  return new Date(2000, 0, 1, hour, minutes).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(' ');
}

/** A heading, a detail line, a warning (if any) and the button for the action's card. */
export function describe(a: DeviceAction, now = Date.now()): { title: string; detail: string; warning: string; button: string; icon: string } {
  if (a.kind === 'alarm') {
    const days = a.days.length === 7 ? 'every day' : a.days.length ? `every ${a.days.map((d) => DAY_NAMES[d]).join(', ')}` : 'once';
    const detail = [a.label, days].filter(Boolean).join(', ');
    return { title: `Alarm at ${clock(a.hour, a.minutes)}`, detail: detail[0].toUpperCase() + detail.slice(1), warning: '', button: 'Set alarm', icon: 'alarm' };
  }
  if (a.kind === 'timer') {
    return { title: `Timer for ${duration(a.seconds)}`, detail: a.label, warning: '', button: 'Start timer', icon: 'timer-outline' };
  }
  const start = new Date(a.begin);
  const date = (a.allDay ? new Date(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) : start)
    .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const endsAt = new Date(a.end);
  const when = a.allDay
    ? `${date}, all day`
    : `${date}, ${clock(start.getHours(), start.getMinutes())} to ${clock(endsAt.getHours(), endsAt.getMinutes())}`;
  // An all-day event's end is midnight UTC, so allow a day either side before calling it past.
  const past = a.end < now - (a.allDay ? 24 * 3600 * 1000 : 0);
  return { title: a.title, detail: when, warning: past ? 'This date has already passed. Check it before you save it.' : '', button: 'Add to calendar', icon: 'calendar-plus' };
}

/** Hand the action to the phone's Clock or Calendar app. Throws with a readable message if it can't. */
export async function runAction(a: DeviceAction): Promise<void> {
  if (!native) throw new Error('Set this from Aislet on your phone.');
  if (a.kind === 'alarm') return native.setAlarm(a.hour, a.minutes, a.label, a.days);
  if (a.kind === 'timer') return native.setTimer(a.seconds, a.label);
  return native.addEvent(a.title, a.begin, a.end, a.allDay);
}

// Words that suggest an alarm, timer or event. A time or a small number counts too ("um 7", "15:00", "10m"), so
// most languages are covered; years, prices, percentages and decimals don't. Only then does the message explain
// actions: it's about 300 tokens, and a shorter prompt is quicker on the phone.
const ACTION_WORDS = /\b(alarms?|wake|waking|timers?|countdown|remind|reminders?|calendar|events?|appointments?|meetings?|schedule|diary|book|tomorrow|tonight|morning|evening|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week)\b/i;
const TIME_OR_SMALL_NUMBER = /(^|[\s(@~])\d{1,2}([:.h]\d{2})?(?![\d%,.]?\d)(?!\s?%)/;

// Asking for words (a reply, a draft, a summary, a translation) isn't asking for a card, however many days and times
// the text has in it: "help me reply to my landlord: the plumber can come Thursday between 8 and 12" had the model
// offer a calendar event or a timer instead of the reply. Naming a card as well ("…and add it to my calendar") still asks.
const WRITING_TASK = /^\W*(?:(?:(?:can|could|would|will) you\s+|please\s+)?(?:help me\s+(?:to\s+)?|i need (?:help\s+)?(?:to\s+)?)?(?:reply|respond|draft|write|compose|summari[sz]e|translate|rewrite|reword|proofread|polish|shorten)|(?:what|how) (?:should|do|can|would) i (?:say|write|reply|respond|answer|text|send))\b/i;
const NAMES_A_CARD = /\b(alarms?|timers?|countdown|remind me|reminders?|wake me|calendar|diary)\b/i;

function writingTask(text: string): boolean {
  return WRITING_TASK.test(text) && !NAMES_A_CARD.test(text);
}

/**
 * Whether the latest message may ask for an alarm, timer or calendar event. The words count in the two messages
 * before it too, so a reply to "what time?" ("seven, please") still gets the explanation; a number counts only in
 * the latest message. A writing task doesn't count, now or as an earlier message ("make it shorter" after a reply).
 */
export function mayWantAction(latest: string, earlier: string[] = []): boolean {
  if (writingTask(latest)) return false;
  return ACTION_WORDS.test(latest) || TIME_OR_SMALL_NUMBER.test(latest) || earlier.some((t) => ACTION_WORDS.test(t) && !writingTask(t));
}

/**
 * What to tell the AI about actions for this message: nothing, how to set them, or how to set them next to a reply
 * ("reply that Thursday's fine and add it to my calendar"). Asked for together, the phone's model wrote one of the
 * two in more than half its tries, and no general wording fixed that without costing the 2B its alarm cards.
 */
export function actionsFor(latest: string, earlier: string[] = []): boolean | 'with-writing' {
  if (!mayWantAction(latest, earlier)) return false;
  return WRITING_TASK.test(latest) && NAMES_A_CARD.test(latest) ? 'with-writing' : true;
}

/** What the AI is told about actions, with today's date and time so it can work out "tomorrow at 7". */
export function actionsPrompt(now = new Date(), withWriting = false): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // Placeholders, not sample values: a small model copies sample days and times into its answer.
  // Asked for a card alone, "reply with one short sentence" first keeps the 2B's card on a line of its own. Asked for a
  // reply as well, that sentence made the 4B write only the sentence and the card, or the reply and "I've added it",
  // so then the short sentence comes after the draft.
  const forms = [
    '[[alarm HH:MM | label]] with a 24-hour time. To repeat it, add the days they asked for: [[alarm HH:MM | label | days]], ' +
      'with days written as mon tue wed thu fri sat sun, or weekdays, weekends or daily.',
    '[[timer length | label]] with lengths like 45s, 10m or 1h30m, up to 24 hours.',
    '[[event YYYY-MM-DD HH:MM | length | title]], or for a whole day: [[event YYYY-MM-DD | all day | title]].',
  ];
  const rules = "Use the name they gave, word for word. Don't work out the weekday of a date: the card shows it. If " +
    'the time or date is unclear, ask first. Add an action line only when they ask you to set an alarm or timer or add ' +
    `an event, and then always add it${withWriting ? '' : ', even next to a reply or draft'}. A day or time inside ` +
    'a message they want replied to or summarised is not a request by itself. ' +
    `It is now ${weekday}, ${today}, ${pad(now.getHours())}:${pad(now.getMinutes())}.`;
  const intro = "You can set alarms and timers in the phone's Clock app and add events to its calendar. ";
  const never = "Nothing happens until they tap the card, so never write that you've set, added or started anything. ";
  if (withWriting) {
    return [
      intro + 'When asked to, put each action alone on its own line at the very end, in exactly one of these forms:',
      ...forms,
      never + 'They also asked for a reply or message: write it in its draft block first, then one short sentence ' +
        'such as "Here it is: tap the card to set it.", then the action line. ' + rules,
    ].join('\n');
  }
  return [
    intro + 'When asked to, reply with one short sentence saying it is ready, such as "Here it is: tap the card to set ' +
      'it.", then put each action alone on its own line at the end, in exactly one of these forms:',
    ...forms,
    never + rules,
  ].join('\n');
}

// Asked for a reply and a card in one message, the phone's 4B wrote the reply and "I've added it to your calendar"
// with no card in about a quarter of its tries. Asked for the card alone, it gets it right, so the app asks again.

/** Whether a reply asked for with a card (actionsFor gave 'with-writing') came without one. */
export function missingCard(wanted: boolean | 'with-writing', reply: string): boolean {
  return wanted === 'with-writing' && parseActions(reply).actions.length === 0;
}

/** The request for the card alone: the instructions and their message, with nothing else to write. */
export function cardOnlyMessages(ask: string, now = new Date()): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: `${actionsPrompt(now)}\nThe reply they asked for has been written already. Write only the action line for the alarm, timer or event in their message, and nothing else.` },
    { role: 'user', content: ask },
  ];
}

// "I've added it to your calendar", outside a draft: not true until they tap the card.
const CLAIM = /[^.!?\n]*\b(?:I'?ve|I have) (?:set|added|created|scheduled|put)\b[^.!?\n]*[.!?]?[ \t]*/gi;

/** The text without a claim that an action is already done; only outside ``` blocks, as a draft may well say it. */
function withoutClaims(text: string): string {
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => (i % 2 ? part : part.replace(CLAIM, ''))).join('')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** The reply with the action lines found in `extra` at its end, and without a claim that it's already done. */
export function withCard(reply: string, extra: string): string {
  const lines = [...extra.matchAll(LINE)].map((m) => `[[${m[1]}${m[2]}]]`).slice(0, 3);
  return lines.length ? `${withoutClaims(reply)}\n\n${lines.join('\n')}` : reply;
}

// "Add it to my calendar" for "Thursday" came back on the 23rd (a Monday) from the 2B, and on the 27th from the 4B. When
// the ask names one weekday, or tomorrow or today, and no date, an event on another day is moved to that one. It's
// done once, when the reply arrives, so the card keeps the date after that day has passed.
const WEEKDAY = /\b(sun|mon|tues|wednes|thurs|fri|satur)day\b/gi;
const WEEKDAY_NUMBER: Record<string, number> = { sun: 0, mon: 1, tues: 2, wednes: 3, thurs: 4, fri: 5, satur: 6 };
const NAMES_A_DATE = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b|\bthe\s+\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}[/.-]\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:next|last)\s+(?:week|month|\w+day)\b/i;

/** The day the ask names plainly, and whether it was a weekday ("Thursday") rather than tomorrow or today. */
function dayFor(ask: string, now: Date): { date: Date; weekday: boolean } | null {
  if (NAMES_A_DATE.test(ask)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = new Set([...ask.matchAll(WEEKDAY)].map((m) => WEEKDAY_NUMBER[m[1].toLowerCase()]));
  const tomorrow = /\btomorrow\b/i.test(ask);
  const todayAsked = /\b(today|tonight|this (morning|afternoon|evening))\b/i.test(ask);
  if (days.size + Number(tomorrow) + Number(todayAsked) !== 1) return null; // none, or more than one: the reply's
  const after = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  if (tomorrow) return { date: after(1), weekday: false };
  if (todayAsked) return { date: today, weekday: false };
  const [day] = days;
  return { date: after((day - today.getDay() + 7) % 7), weekday: true };
}

/** The reply with its events on the day they asked for, when they named it plainly and the reply has another. */
export function eventsOnDayAsked(reply: string, ask: string, now = new Date()): string {
  if (!/\[\[\s*event\b/i.test(reply)) return reply;
  const want = dayFor(ask, now);
  if (!want) return reply;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${want.date.getFullYear()}-${pad(want.date.getMonth() + 1)}-${pad(want.date.getDate())}`;
  return reply.replace(LINE, (line, kind: string) => {
    const m = /(\[\[\s*event\s+)(\d{4})-(\d{2})-(\d{2})/i.exec(line);
    if (kind.toLowerCase() !== 'event' || !m) return line;
    // A weekday they named: any date on that weekday stands ("Monday", said on a Monday evening, may be next week's).
    if (want.weekday && new Date(+m[2], +m[3] - 1, +m[4]).getDay() === want.date.getDay()) return line;
    return line.replace(m[0], `${m[1]}${date}`);
  });
}

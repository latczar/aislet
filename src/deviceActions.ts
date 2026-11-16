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

const LINE = /^[ \t]*\[\[[ \t]*(alarm|timer|event)\b([^\]\n]*)\]\][ \t]*$/gim;
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
    const days = parseDays(parts[2] ?? '');
    if (!time || !days) return null;
    return { kind: 'alarm', ...time, label: clean(parts[1] ?? '', LIMITS.label), days };
  }
  if (kind === 'timer') {
    const seconds = parseDuration(parts[0] ?? '');
    if (!seconds || seconds > LIMITS.timer) return null;
    return { kind: 'timer', seconds, label: clean(parts[1] ?? '', LIMITS.label) };
  }
  // event: "2026-11-18 15:00 | 60m | Dentist" or "2026-11-18 | all day | Birthday"
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\S.*))?$/.exec(parts[0] ?? '');
  const title = clean(parts[2] ?? '', LIMITS.title);
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
  const length = parts[1] ? parseDuration(parts[1]) : 3600;
  if (!time || !length || length > LIMITS.event) return null;
  const begin = new Date(y, mo - 1, d, time.hour, time.minutes).getTime();
  return { kind: 'event', title, begin, end: begin + length * 1000, allDay: false };
}

/**
 * Split a reply into the text to show and the actions it proposes. Action lines are always removed from the text,
 * including one that's still being written; ones that can't be read are counted in `unreadable`.
 */
export function parseActions(reply: string, streaming = false): { text: string; actions: DeviceAction[]; unreadable: number } {
  const actions: DeviceAction[] = [];
  let unreadable = 0;
  if (!reply.includes('[[')) return { text: reply, actions, unreadable };
  let text = reply.replace(LINE, (_, kind: string, body: string) => {
    const action = parseOne(kind.toLowerCase(), body);
    if (action && actions.length < 3) actions.push(action);
    else if (!action) unreadable++;
    return '';
  });
  text = text.replace(ANY_LINE, () => { unreadable++; return ''; });
  if (streaming) text = text.replace(PARTIAL, '');
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

// Words that suggest an alarm, timer or event. Any number counts too ("um 7", "15:00"), so most languages are
// covered. Only then does the prompt explain actions: it's long, and a shorter prompt is quicker on the phone.
const ACTION_WORDS = /\b(alarms?|wake|waking|timers?|countdown|remind|reminders?|calendar|events?|appointments?|meetings?|schedule|diary|book|tomorrow|tonight|morning|evening|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week)\b/i;

/** Whether the latest messages may be asking for an alarm, timer or calendar event. */
export function mayWantAction(texts: string[]): boolean {
  return texts.some((t) => /\d/.test(t) || ACTION_WORDS.test(t));
}

/** What the AI is told about actions, with today's date and time so it can work out "tomorrow at 7". */
export function actionsPrompt(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return [
    "You can set alarms and timers in the phone's Clock app and add events to its calendar. When asked to, write one " +
      "short sentence saying it's ready, such as \"Here's an alarm for 7:30.\", then put the action alone on the last " +
      'line, in exactly one of these forms:',
    '[[alarm 07:30 | Wake up]] (24-hour time; to repeat it, add days: [[alarm 06:45 | Gym | mon wed fri]])',
    '[[timer 10m | Pasta]] (lengths like 45s, 10m or 1h30m, up to 24 hours)',
    '[[event 2026-11-18 15:00 | 60m | Dentist]] (date, start, length, title; all day: [[event 2026-11-18 | all day | Birthday]])',
    "The app shows it as a card and nothing is set until they tap it, so never say it's set, added or done. Use the " +
      'name they gave, word for word. If the time or date is unclear, ask first. Only add an action line when they ' +
      `ask for one. It is now ${weekday}, ${today}, ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}.`,
  ].join('\n');
}

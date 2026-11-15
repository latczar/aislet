// Offline libraries: Kiwix .zim files (Appropedia, Wikipedia, WikiMed and so on). For each question the
// app searches them with Kiwix's own full-text index, picks the passages that best match, and gives
// those to the AI, which names the article it used. Libraries are searched on the device that holds them.
import { STOP_WORDS, chunkText, keywordScore } from './brain';

export interface LibraryBook {
  path: string;
  title: string;
  description: string;
  articles: number;
  size: number;        // bytes
  searchable: boolean; // has a full-text index
  problem?: string;    // couldn't be opened
}

/** A page a library search found, with its HTML (cut to a sensible length). */
export interface LibraryPage {
  book: string;      // the library file's path
  bookTitle: string; // e.g. "Appropedia"
  path: string;      // the page inside the library
  title: string;
  rank: number;      // 0 = the library's best match
  html: string;
}

/** A page found by its title. */
export type LibraryTitle = Pick<LibraryPage, 'book' | 'bookTitle' | 'path' | 'title'>;

/** A passage chosen to help answer. */
export interface LibraryHit {
  book: string;   // e.g. "Appropedia"
  title: string;  // the article
  text: string;
  score: number;  // for ordering
  match?: number; // share of the question's words in the passage
}

/** Where Aislet keeps libraries, under the phone's shared storage. */
export const LIBRARY_FOLDER = 'Aislet/Libraries';
/** Where it kept them when it was called Untethered. Libraries there are still used, where they are. */
export const OLD_LIBRARY_FOLDER = 'Untethered/Libraries';
/** Kiwix's own folder: Android deletes it when Kiwix is uninstalled, so libraries are moved out of it. */
export const KIWIX_FOLDER = 'Android/media/org.kiwix.kiwixmobile';
/** Other places .zim files often end up. */
export const OTHER_FOLDERS = ['Download', 'Documents', 'Kiwix'];

const ASKING = new Set(
  "about also any can could did does explain give hello help i'd i'll i'm im know let like may might must need please really should show tell tells thanks there they want what what's whats would".split(' '),
);

/** The words worth searching for: the question without filler. Kiwix ranks by how well pages match. */
export function searchQuery(question: string): string {
  const words = question.toLowerCase().replace(/[’']/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const kept = words
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !ASKING.has(w));
  return [...new Set(kept)].slice(0, 12).join(' ');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', deg: '°', times: '×' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** The readable text of a library page, with paragraphs kept apart. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/i, ' ')
      .replace(/<(script|style|noscript|svg|math|nav|footer|button)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol|dl|dd|dt|tr|table|blockquote|pre|figcaption|details|summary)\b[^>]*>/gi, '\n\n')
      .replace(/<\/(td|th)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Translations are kept as sub-pages ("Solar cooker/es"); the main page is enough. */
function isTranslation(title: string): boolean {
  return /\/[a-z]{2,3}(-[a-z]{2,4})?$/i.test(title);
}

/** Plural and -ing forms count as the same word: "cookers" is "cooker", "composting" is "compost". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Words to look up by title: the whole query, then each longer word on its own. */
export function titleQueries(query: string): string[] {
  return [query, ...query.split(' ').filter((w) => w.length >= 4)].slice(0, 7);
}

/**
 * Overview articles: pages whose title is made only of words in the question, such as "Compost" for
 * "what's the best way to compost at home?". Kiwix's full-text search can miss these for broad questions.
 * Titles that cover more of the question come first.
 */
export function overviewTitles(query: string, found: LibraryTitle[], max = 2): LibraryTitle[] {
  const terms = new Set(query.split(' ').map(stem));
  const seen = new Set<string>();
  return found
    .map((t) => ({ t, words: (t.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP_WORDS.has(w)).map(stem) }))
    .filter(({ t, words }) => {
      const key = `${t.book}\n${t.path}`;
      if (seen.has(key) || isTranslation(t.title)) return false;
      seen.add(key);
      return words.length > 0 && words.length <= 4 && words.every((w) => terms.has(w));
    })
    .sort((a, b) => b.words.length - a.words.length)
    .slice(0, max)
    .map(({ t }) => t);
}

/**
 * The best passages from the pages a search found: up to two per page, scored by how many of the
 * question's words they contain, with a little extra for a matching title and a high search rank.
 */
export function libraryCandidates(question: string, pages: LibraryPage[], max = 6): LibraryHit[] {
  const seen = new Set<string>();
  const candidates: LibraryHit[] = [];
  for (const page of pages) {
    const key = `${page.book}\n${page.path}`;
    if (seen.has(key) || isTranslation(page.title)) continue;
    seen.add(key);
    const bonus = keywordScore(question, page.title) * 0.15 + 0.1 / (1 + page.rank);
    chunkText(htmlToText(page.html), 700)
      .filter((c) => c.length >= 120)
      .map((text) => ({ text, score: keywordScore(question, text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .forEach((c) => candidates.push({ book: page.bookTitle, title: page.title, text: c.text, score: c.score + bonus, match: c.score }));
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, max);
}

/** How a library reads in a list, e.g. "30,736 articles · 582 MB". */
export function describeBook(book: LibraryBook, size: string): string {
  if (book.problem) return book.problem;
  const parts = [`${book.articles.toLocaleString('en-GB')} ${book.articles === 1 ? 'article' : 'articles'}`, size];
  if (!book.searchable) parts.push("can't be searched");
  return parts.join(' · ');
}

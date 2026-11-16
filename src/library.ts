// Offline libraries: the person's own files (PDFs, ebooks, text, Markdown, web pages) and Kiwix .zim files
// (Appropedia, Wikipedia, WikiMed and so on). For each question the app searches them (Kiwix with its own
// full-text index, your own files with Aislet's index of them), picks the passages that best match, and
// gives those to the AI, which names the file or article it used. Libraries are searched on the device that
// holds them. Your own files are only ever read: Aislet never changes, moves or deletes them.
import { STOP_WORDS, chunkText, keywordScore } from './brain';

/** 'zim' is a Kiwix library; the rest are your own files. */
export type LibraryFormat = 'zim' | 'pdf' | 'epub' | 'text' | 'markdown' | 'html' | string;

export interface LibraryBook {
  path: string;
  title: string;
  description: string;
  articles: number;    // Kiwix: articles. Your own files: pages (PDF), chapters (EPUB) or sections
  size: number;        // bytes
  searchable: boolean; // has a full-text index
  format: LibraryFormat;
  problem?: string;    // couldn't be opened or read, and why
  pending?: boolean;   // your own file, new or changed, not read yet
  sameAs?: string;     // your own file, identical to this one already in the library (searched once)
}

/** A page a library search found: a Kiwix page's HTML (cut to a sensible length) or a passage of your own file. */
export interface LibraryPage {
  book: string;      // the library file's path
  bookTitle: string; // e.g. "Appropedia"
  path: string;      // the page inside the library
  title: string;     // the article, or the part of your file ("page 12", a heading); may be empty
  rank: number;      // 0 = the library's best match
  html?: string;     // Kiwix
  text?: string;     // your own files
}

/** Your own files in a library folder, as the phone's or laptop's reader lists them. */
export interface FileList {
  folder: string;    // where to put them
  books: LibraryBook[];
  skipped: number;   // files left out because there were too many
}

/** Where your own files are read: the phone (native module) or the laptop (hub). */
export interface FileLibrary {
  books(): Promise<FileList>;  // quick: no file contents read
  index(): Promise<FileList>;  // reads new and changed files; can take a while the first time
  search(query: string, limit: number): Promise<LibraryPage[]>;
  openFolder: (() => Promise<void>) | null; // the laptop can show the folder; on a phone, people use their Files app
}

/** A page found by its title. */
export type LibraryTitle = Pick<LibraryPage, 'book' | 'bookTitle' | 'path' | 'title'>;

/** A passage chosen to help answer. */
export interface LibraryHit {
  book: string;   // e.g. "Appropedia", or your file's name
  title: string;  // the article, or the part of your file; may be empty
  text: string;
  score: number;  // for ordering
  match?: number; // share of the question's words in the passage
}

/** Where Aislet keeps libraries, and where you put your own files, under the phone's shared storage. */
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
    const kiwix = page.html !== undefined;
    if (seen.has(key) || (kiwix && isTranslation(page.title))) continue;
    seen.add(key);
    const bonus = keywordScore(question, page.title) * 0.15 + 0.1 / (1 + page.rank);
    // Kiwix pages have menus and captions to skip; your own notes can be short and still be the answer.
    chunkText(kiwix ? htmlToText(page.html ?? '') : (page.text ?? ''), 700)
      .filter((c) => c.length >= (kiwix ? 120 : 1))
      .map((text) => ({ text, score: keywordScore(question, text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .forEach((c) => candidates.push({ book: page.bookTitle, title: page.title, text: c.text, score: c.score + bonus, match: c.score }));
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, max);
}

const KINDS: Record<string, string> = { pdf: 'PDF', epub: 'Ebook', text: 'Text', markdown: 'Markdown', html: 'Web page' };

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/** How a library reads in a list, e.g. "30,736 articles · 582 MB" or "PDF · 24 pages · 3.1 MB". */
export function describeBook(book: LibraryBook, size: string, reading = false): string {
  if (book.problem) return book.problem;
  if (book.pending) return reading ? 'Reading…' : 'Not read yet';
  if (book.sameAs) return `The same file as ${book.sameAs}, so it's only searched once`;
  if (book.format === 'zim') {
    const parts = [count(book.articles, 'article', 'articles'), size];
    if (!book.searchable) parts.push("can't be searched");
    return parts.join(' · ');
  }
  const parts = [KINDS[book.format] ?? book.format.toUpperCase()];
  if (book.format === 'pdf') parts.push(count(book.articles, 'page', 'pages'));
  if (book.format === 'epub') parts.push(count(book.articles, 'chapter', 'chapters'));
  parts.push(size);
  return parts.join(' · ');
}

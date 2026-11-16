// "Search the web" (Settings, off until switched on). Only the search words leave the device, sent to
// DuckDuckGo, which needs no account or key. The phone asks DuckDuckGo itself; the PC window can't (browsers block
// reading another site's page), so the laptop hub fetches the results page for it.
import { Platform } from 'react-native';
import { hubSearch } from './hub';

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

/** What a reply records about its search, for the chat to show. */
export interface WebSearchNote {
  query: string;
  ok: boolean;
}

const RESULTS = 5;
const SEARCH_URL = 'https://html.duckduckgo.com/html/';
// DuckDuckGo turns away requests that don't look like a browser.
const AGENT = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

// Asked outright, or about things that change or are newer than the model. Either only counts in a question or a
// request, so "I'm searching for a job" or "the latest version of my CV is…" don't send anything.
const ASKED = /\b(search|look (it |this |that )?up|google|(check|search|look) online|on the (web|internet))\b/i;
const CURRENT = new RegExp(
  '\\b(latest|newest|news|headlines?|this (week|month|year)|right now|currently|weather|forecast|prices?|cost of|' +
    'exchange rate|stock|share price|scores?|who won|results? of|fixtures|release date|released|came out|' +
    'opening (hours|times)|open now|election|20(2[5-9]|[3-9]\\d))\\b',
  'i',
);
const QUESTION = /\?\s*$|^\s*(please\s+)?(what|who|when|where|which|how|is|are|was|were|did|does|do|has|have|can|could|will|would|should|tell|find|show|give|check|any|search|look|google)\b/i;

/** Whether a message needs current information from the web. Only asked when the setting is on. */
export function needsWeb(text: string): boolean {
  const t = text.trim();
  return !!t && QUESTION.test(t) && (ASKED.test(t) || CURRENT.test(t));
}

/** The words to search for: the question without "can you search for" and the like, kept short. */
export function webQuery(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^(hey|hi|ok(ay)?|so|please|pls|can you|could you|would you|will you)[,\s]+/i, '')
    .replace(/^(please\s+)?(search( the web| online| google)?( for)?|look up|google|find( me)?( out)?)\s+/i, '')
    .replace(/\s+(please|pls|thanks|thank you)[.!]*$/i, '')
    .trim()
    .slice(0, 200);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·',
};

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** A result's real address: DuckDuckGo sometimes wraps it in its own redirect. Only web addresses are kept. */
function realUrl(href: string): string | null {
  let url = plain(href);
  if (url.startsWith('//')) url = `https:${url}`;
  const wrapped = url.match(/[?&]uddg=([^&]+)/);
  if (wrapped) {
    try {
      url = decodeURIComponent(wrapped[1]);
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\/[^/\s]+/i.test(url) || /^https?:\/\/([^/]*\.)?duckduckgo\.com\/y\.js/i.test(url)) return null; // y.js: an ad
  return url;
}

/** The results on DuckDuckGo's HTML page, without ads. */
export function parseResults(html: string, limit = RESULTS): WebHit[] {
  const hits: WebHit[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/i.test(block.slice(0, 200))) continue;
    const link = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = realUrl(link[1]);
    const title = plain(link[2]);
    if (!url || !title || hits.some((h) => h.url === url)) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/i);
    hits.push({ title: title.slice(0, 200), url, snippet: snippet ? plain(snippet[1]).slice(0, 400) : '' });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Search DuckDuckGo. Throws a message fit to show when it can't. */
export async function searchWeb(query: string): Promise<WebHit[]> {
  let html: string;
  if (Platform.OS === 'web') {
    html = (await hubSearch(query)).html;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': AGENT, Accept: 'text/html', 'Accept-Language': 'en' },
        body: `q=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`DuckDuckGo replied with an error (${res.status}).`);
      html = (await res.text()).slice(0, 2_000_000);
    } catch (e) {
      throw new Error(controller.signal.aborted ? 'The search took too long.' : (e as Error).message.startsWith('DuckDuckGo')
        ? (e as Error).message : "Couldn't reach DuckDuckGo. Check you're online.");
    } finally {
      clearTimeout(timer);
    }
  }
  const hits = parseResults(html);
  if (!hits.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('DuckDuckGo asked to check this is a person. Try again in a minute.');
  return hits;
}

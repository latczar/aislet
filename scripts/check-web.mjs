// Checks "Search the web" (src/webSearch.ts): reading DuckDuckGo's results page, when a message counts as needing
// the web, and the words that get searched for.
//   node scripts/check-web.mjs          (offline: a made-up results page)
//   node scripts/check-web.mjs --live   (also one real search, for a neutral test query)
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require(join(root, 'node_modules/typescript'));
const out = mkdtempSync(join(tmpdir(), 'aislet-web-'));
writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');
// Stand-ins for the app's modules: the phone's way of searching (straight to DuckDuckGo) is the one checked live.
writeFileSync(join(out, 'rn.js'), "exports.Platform = { OS: 'android' };");
writeFileSync(join(out, 'hub.js'), "exports.hubSearch = async () => { throw new Error('not used'); };");
const source = readFileSync(join(root, 'src/webSearch.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/require\("react-native"\)/, 'require("./rn.js")')
  .replace(/require\("\.\/hub"\)/, 'require("./hub.js")');
writeFileSync(join(out, 'webSearch.js'), js);
const web = require(join(out, 'webSearch.js'));
rmSync(out, { recursive: true, force: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
};

// A made-up page in DuckDuckGo's HTML layout: an ad first, a result behind its redirect, entities and bold words.
const page = `
<div class="results">
  <div class="result results_links results_links_deep result--ad ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example">Buy kettles now</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=shop.example">Ad text</a>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://kettle.example/descale">How to descale a <b>Brindlewick</b> kettle</a></h2>
    <a class="result__snippet" href="https://kettle.example/descale">Use citric acid &amp; water, then rinse. It&#x27;s quick &mdash; <b>10 minutes</b>.</a>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example%2Fglimmerfold%3Fa%3D1&amp;rut=abc">Glimmerfold festival &quot;2026&quot; dates</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Dates announced for the Glimmerfold kite festival.</a>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://kettle.example/descale">Same page again</a></h2>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="javascript:alert(1)">Not a web page</a></h2>
  </div>
</div>`;
const hits = web.parseResults(page);
check('ads, repeats and non-web links are left out', hits.length === 2, `${hits.length} results`);
check('title without its tags', hits[0]?.title === 'How to descale a Brindlewick kettle', hits[0]?.title);
check('snippet with its entities read', hits[0]?.snippet === "Use citric acid & water, then rinse. It's quick — 10 minutes.", hits[0]?.snippet);
check("DuckDuckGo's redirect is unwrapped", hits[1]?.url === 'https://news.example/glimmerfold?a=1', hits[1]?.url);
check('quotes in a title', hits[1]?.title === 'Glimmerfold festival "2026" dates', hits[1]?.title);
check('at most five results', web.parseResults(page.repeat(1).replace(/<\/div>\s*$/, '') + Array.from({ length: 8 }, (_, i) =>
  `<div class="result web-result"><a class="result__a" href="https://site${i}.example/">Site ${i}</a></div>`).join('')).length === 5);
check('an empty page gives no results', web.parseResults('<html><body>No results.</body></html>').length === 0);

const needs = [
  "What's the latest Expo SDK version?",
  'Search the web for Chiang Mai weather',
  'Can you look up the opening hours of the Kettle Café?',
  'Who won the match last night?',
  'Weather in Chiang Mai tomorrow?',
  'How much is the exchange rate from baht to pounds right now?',
  'What happened in the 2026 election?',
  'please google the release date for Glimmerfold 2',
];
const doesnt = [
  "I'm searching for a job",
  'The latest version of my CV is attached.',
  'Help me plan my day',
  'What is a closure in JavaScript?',
  'Nah simmer down bro',
  'I go to the gym every day',
  'Help me reply to my landlord: The plumber can come on Thursday between 8 and 12. Does that work for you?',
  'Tell me how to start coding Python',
];
for (const t of needs) check(`needs the web: ${t}`, web.needsWeb(t));
for (const t of doesnt) check(`no search: ${t}`, !web.needsWeb(t));

check('search words: the request words go', web.webQuery('Can you search the web for Chiang Mai weather please') === 'Chiang Mai weather',
  web.webQuery('Can you search the web for Chiang Mai weather please'));
check('search words: a question stays as it is', web.webQuery("What's the latest Expo SDK version?") === "What's the latest Expo SDK version?");
check('search words: at most 200 characters', web.webQuery('a '.repeat(300)).length <= 200);

if (process.argv.includes('--live')) {
  const live = await web.searchWeb('expo sdk release notes').catch((e) => e);
  check('live search on DuckDuckGo', Array.isArray(live) && live.length >= 3 && live.every((h) => /^https?:\/\//.test(h.url)),
    Array.isArray(live) ? `${live.length} results, first ${live[0]?.url}` : live.message);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

// Answer-quality eval: made-up prompts with pass/fail rules, sent to Ollama through the app's own prompt code
// (src/brain.ts) and Ollama engine (src/engine/ollama.ts), so it tests what the app really sends.
//
//   node scripts/eval/run.mjs                       laptop model, as the PC app picks it
//   node scripts/eval/run.mjs --model qwen3.5:4b    another Ollama model (for example the phone's tier)
//   node scripts/eval/run.mjs --runs 3 --only identity-name,draft-text
//
// Options: --url (Ollama, default http://localhost:11434), --model, --runs (default 1), --seed (default 42),
// --only (case ids or groups, comma-separated), --cases (extra case files, comma-separated),
// --out (JSON file for the answers and timings), --quiet.
// Needs Node 22.18+ (it loads the app's TypeScript directly) and nothing else. Exit code 0 only if every case passes.
//
// More cases: put a file in scripts/eval/cases/ (it's loaded by itself) or pass it with --cases. It exports CASES,
// an array like the one in cases.mjs, and can import the check helpers and made-up data from '../cases.mjs'. A case
// can also set:
//   memories: [...]     its own memories instead of the shared made-up ones
//   settings: {...}     settings to change (name, instructions, length, webSearch)
//   history: [...]      earlier messages in the chat
//   build: (app) => [...messages]   build the messages itself (app has brain and buildMessages), e.g. learnMessages
//   json: true          ask as the app's learning and tidying do (engine.json); checks get x.data, the parsed JSON
//   filler: false       skip the filler opener/closer checks (they're skipped for Get to know me and json cases)
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as app from './app.mjs';
import { CASES, FILLER_CLOSER, FILLER_OPENER, SETTINGS } from './cases.mjs';
import { createSend } from './ollama-send.mjs';

const { brain, buildMessages, createOllamaEngine } = app;

/** The built-in cases, then every file in scripts/eval/cases/, then any given with --cases. Ids must be unique. */
async function loadCases(extra) {
  const dir = new URL('./cases/', import.meta.url);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort().map((f) => new URL(f, dir).href);
  } catch {
    // no extra case folder
  }
  files.push(...(extra ? extra.split(',').map((p) => pathToFileURL(resolve(p)).href) : []));
  const all = [...CASES];
  for (const file of files) {
    const mod = await import(file);
    if (!Array.isArray(mod.CASES)) throw new Error(`${file} doesn't export a CASES array`);
    all.push(...mod.CASES);
  }
  const seen = new Set();
  for (const c of all) {
    if (!c.id || !c.group || !Array.isArray(c.checks)) throw new Error(`case ${c.id ?? '(no id)'} needs an id, a group and checks`);
    if (seen.has(c.id)) throw new Error(`two cases are called ${c.id}`);
    seen.add(c.id);
  }
  return all;
}

function args() {
  const out = { url: 'http://localhost:11434', runs: 1, seed: 42, quiet: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'quiet') out.quiet = true;
    else out[k] = a[++i];
  }
  out.runs = Number(out.runs);
  out.seed = Number(out.seed);
  return out;
}

/** The parts of an answer the checks look at. */
function analyse(answer) {
  const drafts = [...answer.matchAll(/```draft[^\n]*\n([\s\S]*?)(```|$)/g)].map((m) => m[1].trim());
  const outside = answer.replace(/```draft[^\n]*\n[\s\S]*?(```|$)/g, ' ').trim();
  const withoutActions = answer.replace(/^\s*\[\[[^\]]*\]\]\s*$/gm, '').trim();
  const plain = withoutActions.replace(/```draft[^\n]*\n[\s\S]*?(```|$)/g, ' ').replace(/[*_#>`|-]+/g, ' ');
  const words = plain.split(/\s+/).filter((w) => /\w/.test(w)).length;
  const outsideWords = outside.replace(/[*_#>`|-]+/g, ' ').split(/\s+/).filter((w) => /\w/.test(w)).length;
  const questions = (outside.match(/\?/g) ?? []).length;
  let data = null;
  try {
    data = JSON.parse(answer);
  } catch {
    // not JSON: only json cases look at it
  }
  return { drafts, outside, withoutActions, words, outsideWords, questions, data };
}

function judge(c, answer) {
  const x = analyse(answer);
  const checks = c.checks.map(([label, fn]) => {
    try {
      return { label, ok: !!fn(answer, x) };
    } catch (e) {
      return { label: `${label} (check failed: ${e.message})`, ok: false };
    }
  });
  if (c.mode !== 'interview' && !c.json && c.filler !== false) {
    checks.push({ label: 'no filler opener', ok: !FILLER_OPENER.test(answer) });
    checks.push({ label: 'no filler closer', ok: !FILLER_CLOSER.test(x.outside.trim()) });
  }
  return { checks, ok: checks.every((k) => k.ok), words: x.words };
}

async function main() {
  const opt = args();
  const only = opt.only ? new Set(opt.only.split(',')) : null;
  const cases = (await loadCases(opt.cases)).filter((c) => !only || only.has(c.id) || only.has(c.group));
  if (!cases.length) throw new Error('no cases match --only');
  let seed = opt.seed;
  const timing = { last: null };
  // --model swaps the model in each request; otherwise the engine's status() picks it, as the app does.
  const engine = createOllamaEngine({ send: createSend(opt.url, () => seed, timing, opt.model), where: 'laptop', label: 'eval' });
  const status = await engine.status();
  if (!status.ready) throw new Error(status.problem);
  const model = opt.model ?? status.model;
  const results = [];
  for (const c of cases) {
    const runs = [];
    for (let r = 0; r < opt.runs; r++) {
      seed = opt.seed + r;
      const messages = c.build ? c.build(app) : buildMessages(c);
      let answer = '';
      const started = performance.now();
      let first = null;
      if (c.json) {
        timing.last = null; // engine.json doesn't stream, so there are no per-reply timings
        answer = await engine.json(messages, undefined, c.maxTokens ?? 256);
      } else {
        await engine.chat(messages, undefined, (token) => {
          first ??= performance.now() - started;
          answer += token;
        }, c.maxTokens ?? brain.MAX_TOKENS[c.settings?.length ?? SETTINGS.length]);
      }
      answer = brain.stripThinking(answer).trim();
      // As the app does when asked to stop a "get to know me" chat.
      if (!c.build && c.mode === 'interview' && brain.stopsQuestions(c.ask)) answer = brain.withoutClosingQuestion(answer);
      const verdict = judge(c, answer);
      runs.push({ seed, answer, ...verdict, firstTokenMs: first && Math.round(first), stats: timing.last });
    }
    const passed = runs.filter((r) => r.ok).length;
    results.push({ id: c.id, group: c.group, ask: c.ask, passed, runs });
    if (!opt.quiet) {
      const failing = [...new Set(runs.flatMap((r) => r.checks.filter((k) => !k.ok).map((k) => k.label)))];
      console.log(`${passed === runs.length ? 'PASS' : 'FAIL'}  ${c.id.padEnd(20)} ${passed}/${runs.length}${failing.length ? `  failed: ${failing.join('; ')}` : ''}`);
    }
  }
  const totalRuns = results.reduce((n, r) => n + r.runs.length, 0);
  const passedRuns = results.reduce((n, r) => n + r.passed, 0);
  const allChecks = results.flatMap((r) => r.runs.flatMap((x) => x.checks));
  const groups = {};
  for (const r of results) {
    groups[r.group] ??= { passed: 0, total: 0 };
    groups[r.group].passed += r.passed;
    groups[r.group].total += r.runs.length;
  }
  const summary = {
    model, url: opt.url, seed: opt.seed, runs: opt.runs, date: new Date().toISOString(),
    score: `${passedRuns}/${totalRuns}`, percent: Math.round((100 * passedRuns) / totalRuns),
    checks: `${allChecks.filter((k) => k.ok).length}/${allChecks.length}`,
    groups,
  };
  console.log(`\n${model}: ${summary.score} cases passed (${summary.percent}%), ${summary.checks} checks`);
  for (const [g, v] of Object.entries(groups)) console.log(`  ${g.padEnd(16)} ${v.passed}/${v.total}`);
  if (opt.out) {
    mkdirSync(dirname(opt.out), { recursive: true });
    writeFileSync(opt.out, JSON.stringify({ summary, results }, null, 2));
    console.log(`Answers and timings: ${opt.out}`);
  }
  process.exitCode = passedRuns === totalRuns ? 0 : 1;
}

await main();

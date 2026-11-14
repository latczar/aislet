// List the licence of every production dependency and write THIRD_PARTY_LICENSES.md.
// Usage: node scripts/third-party-licences.js .
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const out = execSync('npm ls --omit=dev --all --parseable', { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();
const dirs = [...new Set(out.split(/\r?\n/).filter((d) => d && path.resolve(d) !== path.resolve(root)))];

const byLicence = {};
const entries = [];
for (const dir of dirs) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
  let lic = pkg.license || (pkg.licenses && pkg.licenses.map((l) => l.type || l).join(' OR ')) || 'UNKNOWN';
  if (typeof lic === 'object') lic = lic.type || 'UNKNOWN';
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : '';
  byLicence[lic] = (byLicence[lic] || 0) + 1;
  entries.push({ name: pkg.name, version: pkg.version, lic, text });
}

const permissive = /^(\(?)(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Unlicense|Python-2\.0|CC-BY-4\.0)/i;
const concerns = entries.filter((e) => !permissive.test(e.lic) || /GPL|AGPL|SSPL|BUSL|Commons Clause|UNKNOWN/i.test(e.lic));
console.log('Packages:', entries.length);
console.log('By licence:', JSON.stringify(byLicence));
console.log('Needs a look:', concerns.map((e) => `${e.name}@${e.version} (${e.lic})`).join(', ') || 'none');

entries.sort((a, b) => a.name.localeCompare(b.name));
const md = [
  '# Third-party licences',
  '',
  'Untethered is built with the open-source packages below. Their licences and copyright notices are reproduced here as those licences require.',
  '',
  'AI models are not included in the app: they are downloaded by the user from their publishers on Hugging Face or through Ollama, under their own licences (Qwen3.5, Qwen3 and nomic-embed-text v1.5 are Apache 2.0).',
  '',
  '## Also included or used',
  '',
  '- **llama.cpp and ggml** (compiled into the Android app through llama.rn): MIT licence, copyright (c) 2023-2026 The ggml authors.',
  '- **Inter typeface** by Rasmus Andersson: SIL Open Font License 1.1 (see @expo-google-fonts/inter below).',
  '- **Material Design Icons** by Pictogrammers: Apache License 2.0 (bundled through @expo/vector-icons).',
  '- **Ollama** (installed separately on Windows by the installer): MIT licence.',
  '- **pypdf** (installed separately for the laptop hub): BSD 3-Clause licence.',
  '- **Python** (installed separately): Python Software Foundation License.',
  '',
  ...entries.map((e) => [`## ${e.name} ${e.version}`, '', `Licence: ${e.lic}`, '', e.text ? '```\n' + e.text.replace(/```/g, "'''") + '\n```' : '(No licence file was included in the package.)', ''].join('\n')),
].join('\n');
fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), md);
console.log('Wrote THIRD_PARTY_LICENSES.md');

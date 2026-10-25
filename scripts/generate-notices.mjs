import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputName = 'THIRD_PARTY_NOTICES.txt';
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--check', '--copy-dist']);

// These npm tarballs omit the repository's license. The reviewed upstream text
// is kept locally, pinned to these versions rather than guessed from SPDX alone.
// https://raw.githubusercontent.com/remarkjs/remark-math/rehype-katex@7.0.1/license
// https://raw.githubusercontent.com/remarkjs/remark-math/6.0.0/license
const upstreamLicenses = new Map([
  ['rehype-katex@7.0.1', 'licenses/remark-math-LICENSE.txt'],
  ['remark-math@6.0.0', 'licenses/remark-math-LICENSE.txt'],
]);
const licenseFileName = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/i;
// New expressions need an explicit license review before automatic distribution.
const reviewedLicenses = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);

function normalized(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd() + '\n';
}

async function readText(relative) {
  try {
    return normalized(await fs.readFile(path.join(root, relative), 'utf8'));
  } catch {
    throw new Error(`Cannot read ${relative}. Run npm ci and check the reviewed license sources.`);
  }
}

async function readPackage(relative, locked) {
  if (!relative.startsWith('node_modules/') || relative.split('/').some((part) => part === '..')) {
    throw new Error(`Unsupported package path in lockfile: ${relative}`);
  }
  const name = relative.split('node_modules/').at(-1);
  const installed = JSON.parse(await readText(`${relative}/package.json`));
  if (installed.name !== name || installed.version !== locked.version) {
    throw new Error(`Installed ${name} does not match lockfile version ${locked.version}. Run npm ci.`);
  }
  if (typeof locked.license !== 'string' || locked.license.length === 0) {
    throw new Error(`Missing license metadata for ${name}@${locked.version}; review before distributing.`);
  }
  if (!reviewedLicenses.has(locked.license)) {
    throw new Error(`Unreviewed license ${locked.license} for ${name}@${locked.version}; review before distributing.`);
  }
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && licenseFileName.test(entry.name))
    .map((entry) => entry.name).sort();
  const upstream = upstreamLicenses.get(`${name}@${locked.version}`);
  if (files.length === 0 && upstream === undefined) {
    throw new Error(`No license text found for ${name}@${locked.version}; review its upstream license.`);
  }
  const sources = files.length > 0
    ? await Promise.all(files.map(async (file) => ({
      source: `${name}/${file}`, text: await readText(`${relative}/${file}`),
    })))
    : [{ source: upstream, text: await readText(upstream) }];
  for (const source of sources) {
    if (source.text.trim().length === 0) throw new Error(`Empty license text for ${name}@${locked.version}`);
  }
  return { name, version: locked.version, license: locked.license, sources };
}

async function generate() {
  const lock = JSON.parse(await readText('package-lock.json'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Expected npm lockfile version 3.');
  const selected = Object.entries(lock.packages)
    .filter(([relative, info]) => relative !== '' && info.dev !== true);
  // Vite injects small runtime helpers. Retain its complete published notice
  // conservatively; build-only tooling is otherwise outside this inventory.
  if (!selected.some(([relative]) => relative === 'node_modules/vite')) {
    const vite = lock.packages['node_modules/vite'];
    if (!vite) throw new Error('Vite is missing from the lockfile.');
    selected.push(['node_modules/vite', vite]);
  }
  const packages = await Promise.all(selected.map(([relative, info]) => readPackage(relative, info)));
  packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version.localeCompare(b.version));
  const katex = packages.find((entry) => entry.name === 'katex');
  if (katex?.version !== '0.16.47') {
    throw new Error('Review the KaTeX font license source for the new installed KaTeX version.');
  }
  packages.push({
    name: 'KaTeX bundled fonts', version: `katex ${katex.version}`, license: 'MIT',
    sources: [{ source: 'licenses/katex-fonts-LICENSE.txt', text: await readText('licenses/katex-fonts-LICENSE.txt') }],
  });

  const groups = [];
  const byText = new Map();
  const index = [];
  for (const entry of packages) {
    const references = [];
    for (const source of entry.sources) {
      const digest = createHash('sha256').update(source.text).digest('hex');
      let group = byText.get(digest);
      if (group === undefined) {
        group = { id: `L${String(groups.length + 1).padStart(3, '0')}`, text: source.text, sources: [] };
        groups.push(group);
        byText.set(digest, group);
      }
      group.sources.push(`${entry.name}@${entry.version} — ${source.source}`);
      references.push(group.id);
    }
    index.push(`${entry.name}@${entry.version} | ${entry.license} | ${references.join(', ')}`);
  }
  return [
    'AIchat-graph — Third-party notices',
    'Generated by npm run notices. Do not edit this file manually.',
    '',
    'Scope: the production dependency records in package-lock.json, plus the',
    'complete Vite notice for injected runtime helpers and the KaTeX font license.',
    'This conservative inventory is not an exact list of modules in the browser bundle.',
    'Upstream copyright and permission texts remain under their original licenses.',
    'The AIchat-graph project license is in LICENSE; user discussion content is separate.',
    'Identical texts are included once and mapped to all applicable packages below.',
    'Reviewed supplemental sources:',
    'rehype-katex@7.0.1: https://raw.githubusercontent.com/remarkjs/remark-math/rehype-katex@7.0.1/license',
    'remark-math@6.0.0: https://raw.githubusercontent.com/remarkjs/remark-math/6.0.0/license',
    'KaTeX fonts: https://raw.githubusercontent.com/KaTeX/katex-fonts/56e79c93c88c9054b017cc92e496b383e0bf82d7/LICENSE',
    '',
    'PACKAGE INDEX',
    ...index,
    '',
    ...groups.flatMap((group) => [
      '='.repeat(72),
      group.id,
      ...group.sources,
      '-'.repeat(72),
      group.text,
    ]),
  ].join('\n');
}

try {
  for (const argument of args) {
    if (!allowedArgs.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  }
  const text = await generate();
  let previous;
  try { previous = await fs.readFile(path.join(root, outputName), 'utf8'); } catch { /* First generation. */ }
  if (args.has('--check')) {
    if (previous !== text) throw new Error(`${outputName} is stale or missing. Run npm run notices.`);
  } else if (previous !== text) {
    await fs.writeFile(path.join(root, outputName), text, 'utf8');
  }
  if (args.has('--copy-dist')) {
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    for (const name of ['LICENSE', outputName]) {
      const content = name === outputName ? text : await readText(name);
      let existing;
      try { existing = await fs.readFile(path.join(root, 'dist', name), 'utf8'); } catch { /* First build. */ }
      if (content !== existing) await fs.writeFile(path.join(root, 'dist', name), content, 'utf8');
    }
  }
  console.log(`${outputName}: ${args.has('--check') ? 'current' : 'ready'}`);
} catch (error) {
  console.error(`[notices] ${error.message}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
// Regenerates extension/src/pricing/snapshot.json: the bundled price fallback.
// It keeps only cost + limit for the models named in config/providers.json (pinned lists) and
// config/models.example.json (chain), resolved against https://models.dev/api.json (MIT).
//
//   node scripts/update-pricing-snapshot.mjs [path/to/api.json]   (omit the path to download)
//
// Matching mirrors extension/src/pricing/resolve.ts: ids compare equal after lowercasing and
// turning runs of non-alphanumerics into "-", first under the mapped provider, then anywhere.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER_MAP = {
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  'google-gemini': 'google',
  groq: 'groq',
  vertex: 'google-vertex',
};
const trimCost = (c) =>
  Object.fromEntries(
    ['input', 'output', 'cache_read', 'cache_write']
      .filter((k) => typeof c?.[k] === 'number')
      .map((k) => [k, c[k]]),
  );
const trimLimit = (l) =>
  Object.fromEntries(
    ['context', 'output'].filter((k) => typeof l?.[k] === 'number').map((k) => [k, l[k]]),
  );
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const providers = JSON.parse(
  readFileSync(join(root, 'config', 'providers.json'), 'utf8'),
).providers;
const example = JSON.parse(readFileSync(join(root, 'config', 'models.example.json'), 'utf8'));

const wanted = new Set();
for (const [name, p] of Object.entries(providers)) {
  if (p.enabled && Array.isArray(p.models)) for (const m of p.models) wanted.add(`${name}/${m}`);
}
for (const n of [...(example.chain ?? []), example.agentMode, example.inlineEdit])
  if (n) wanted.add(n);

const src = process.argv[2];
const raw = src
  ? JSON.parse(readFileSync(src, 'utf8'))
  : await (await fetch('https://models.dev/api.json')).json();

const out = {};
const missing = [];
for (const name of [...wanted].sort()) {
  const i = name.indexOf('/');
  const provider = name.slice(0, i);
  const model = name.slice(i + 1);
  if (provider === 'ollama') continue;
  const tail = model.slice(model.lastIndexOf('/') + 1);
  const cands = [model, tail].map(norm);
  const pid = PROVIDER_MAP[provider] ?? provider;
  let hit;
  for (const p of [pid, ...Object.keys(raw)]) {
    for (const [mid, m] of Object.entries(raw[p]?.models ?? {})) {
      if (cands.includes(norm(mid))) {
        hit = { p, mid, m };
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    missing.push(name);
    continue;
  }
  (out[hit.p] ??= {})[hit.mid] = {
    ...(hit.m.cost ? { cost: trimCost(hit.m.cost) } : {}),
    ...(hit.m.limit ? { limit: trimLimit(hit.m.limit) } : {}),
  };
}

writeFileSync(
  join(root, 'extension', 'src', 'pricing', 'snapshot.json'),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(
  `wrote snapshot: ${Object.values(out).reduce((n, v) => n + Object.keys(v).length, 0)} models`,
);
if (missing.length) console.log(`no models.dev entry for: ${missing.join(', ')}`);

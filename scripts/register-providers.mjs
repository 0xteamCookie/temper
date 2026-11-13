#!/usr/bin/env node
// Copyright 2026 The Temper Authors. SPDX-License-Identifier: Apache-2.0
//
// Registers model providers in a locally running TrueForge from the values in
// .env. Keys are sent only to TrueForge (which stores them); they are never
// printed, logged, or written anywhere else. The Temper extension never reads
// these keys and never calls a model provider directly.
//
// Usage:  node scripts/register-providers.mjs [--env .env] [--base http://127.0.0.1:8790] [--remove name,name] [--dry-run]

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ENV_PATH = resolve(opt('--env', '.env'));
const BASE = opt('--base', process.env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const DRY = args.includes('--dry-run');
const REMOVE = opt('--remove', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseEnv(path) {
  if (!existsSync(path)) {
    console.error(`No env file at ${path}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function main() {
  const env = parseEnv(ENV_PATH);

  const health = await fetch(`${BASE}/`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`TrueForge is not reachable at ${BASE}. Start it first: scripts/start-trueforge.(sh|ps1)`);
    process.exit(1);
  }

  const catalog = (await api('GET', '/catalogs/model-providers')).json.data ?? [];
  const catalogModels = (type) => catalog.find((p) => p.type === type)?.models ?? [];

  /** Pick catalog models by preferred ids (first that exist), keeping catalog properties. */
  const fromCatalog = (type, preferred) => {
    const all = catalogModels(type);
    const picked = preferred.map((id) => all.find((m) => m.model_id === id)).filter(Boolean);
    return picked.length ? picked : all.slice(0, 2);
  };

  /** Custom (OpenAI-compatible) models: "id" or "id:alias" entries; context length from *_CONTEXT. */
  const customModels = (ids, contextLength) =>
    ids.map((entry) => {
      const [model_id, alias] = entry.split('|');
      return {
        model_id,
        name: (alias || model_id).replace(/[^A-Za-z0-9._-]/g, '-'),
        properties: { context_length: contextLength, max_output_tokens: 8192 },
      };
    });

  const providers = [];

  if (env.ANTHROPIC_API_KEY) {
    providers.push({
      type: 'anthropic',
      auth: { api_key: env.ANTHROPIC_API_KEY },
      models: list(env.ANTHROPIC_MODELS).length
        ? fromCatalog('anthropic', list(env.ANTHROPIC_MODELS))
        : fromCatalog('anthropic', ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']),
    });
  }
  if (env.GEMINI_API_KEY) {
    providers.push({
      type: 'google-gemini',
      auth: { api_key: env.GEMINI_API_KEY },
      models: list(env.GEMINI_MODELS).length
        ? fromCatalog('google-gemini', list(env.GEMINI_MODELS))
        : fromCatalog('google-gemini', ['gemini-flash-latest', 'gemini-3.1-pro-preview']),
    });
  }
  const custom = [
    ['openrouter', env.OPENROUTER_API_KEY, 'https://openrouter.ai/api/v1', env.OPENROUTER_MODELS],
    ['groq', env.GROQ_API_KEY, 'https://api.groq.com/openai/v1', env.GROQ_MODELS],
    ['truefoundry', env.TRUEFOUNDRY_API_KEY, env.TRUEFOUNDRY_GATEWAY_BASE_URL, env.TRUEFOUNDRY_MODELS],
    ['ollama', '', env.OLLAMA_BASE_URL, env.OLLAMA_MODELS],
  ];
  for (const [name, key, baseUrl, models] of custom) {
    const ids = list(models);
    const needsKey = name !== 'ollama';
    if (!baseUrl || (needsKey && !key)) continue;
    if (!ids.length) {
      console.warn(`- ${name}: skipped (set ${name.toUpperCase()}_MODELS in .env to the model ids you want)`);
      continue;
    }
    providers.push({
      type: 'custom',
      name,
      base_url: baseUrl,
      ...(key ? { auth: { api_key: key } } : {}),
      models: customModels(ids, Number(env[`${name.toUpperCase()}_CONTEXT`]) || 128000),
    });
  }

  for (const name of REMOVE) {
    if (DRY) {
      console.log(`- would remove ${name}`);
      continue;
    }
    const r = await api('DELETE', `/settings/model-providers/${encodeURIComponent(name)}`);
    console.log(`- removed ${name}: HTTP ${r.status}`);
  }

  if (!providers.length) {
    console.log('No providers configured in .env (all blank). Nothing to register.');
  }

  for (const manifest of providers) {
    const label = manifest.name || manifest.type;
    const models = manifest.models.map((m) => m.name).join(', ');
    if (DRY) {
      console.log(`- would register ${label}: ${models}`);
      continue;
    }
    let r = await api('POST', '/settings/model-providers', { manifest });
    if (r.status === 409) r = await api('PUT', '/settings/model-providers', { manifest });
    const ok = r.status >= 200 && r.status < 300;
    const err = ok ? '' : ` - ${r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 200)}`;
    console.log(`${ok ? '+' : '!'} ${label} (${models}): HTTP ${r.status}${err}`);
  }

  const all = (await api('GET', '/models')).json.data ?? [];
  console.log(`\nModels available in TrueForge (${all.length}):`);
  for (const m of all) console.log(`  ${m.name}`);
  console.log('\nUse these names in the Temper model router (setting: temper.models.chain).');
}

main().catch((e) => {
  console.error(`register-providers failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

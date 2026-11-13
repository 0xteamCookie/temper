#!/usr/bin/env node
// Copyright 2026 The Temper Authors. SPDX-License-Identifier: Apache-2.0
//
// Provisions model providers in a locally running TrueForge, in four layers:
//   1. Secrets    .env                     keys + environment-specific endpoints only
//   2. Discovery  provider APIs            what each account can actually use
//   3. Policy     config/providers.json    which models we want (pinned ids or filters)
//   4. Registration  TrueForge             POST /settings/model-providers (409 -> PUT)
// Keys are sent only to their own provider and to TrueForge; they are never printed,
// logged, or written anywhere else. The Temper extension never reads these keys and
// never calls a model provider directly.
//
// Usage:  node scripts/register-providers.mjs [--check] [--dry-run] [--watch]
//             [--env .env] [--policy config/providers.json] [--base http://127.0.0.1:8790]
//             [--remove name,name]
//   --check    validate every configured key with a read-only call; register nothing
//   --dry-run  discover and select, but do not register or remove anything
//   --watch    re-run every 45 minutes (refreshes the short-lived Vertex AI token)
//   --remove   delete the named providers from TrueForge (never done automatically)

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ENV_PATH = resolve(opt('--env', '.env'));
const POLICY_PATH = resolve(opt('--policy', resolve(import.meta.dirname, '..', 'config', 'providers.json')));
const BASE = opt('--base', process.env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const WATCH = args.includes('--watch');
const REMOVE = opt('--remove', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REFRESH_MS = 45 * 60 * 1000;
const DEFAULT_MAX_MODELS = 3;

const errMsg = (e) => (e instanceof Error ? e.message : String(e));

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

function loadPolicy(path) {
  if (!existsSync(path)) {
    console.error(`No policy file at ${path}.`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')).providers ?? {};
  } catch (e) {
    console.error(`Cannot parse ${path}: ${errMsg(e)}`);
    process.exit(1);
  }
}

/** GET/POST JSON from any URL. Never includes request headers (keys) in the result. */
async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, json };
}

/** Like http() but throws a short, key-free error on a non-2xx answer. */
async function getOk(url, headers) {
  const r = await http('GET', url, { headers });
  if (!r.ok) {
    const detail = r.json?.error?.message ?? r.json?.error ?? r.json?.message ?? '';
    throw new Error(`HTTP ${r.status}${detail ? ` ${String(detail).slice(0, 120)}` : ''}`);
  }
  return r.json;
}

const tf = (method, path, body) => http(method, `${BASE}/api/v1${path}`, { body });

/* ----------------------------- Vertex AI ----------------------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Access token from a service-account JSON (JWT bearer grant), no extra dependencies. */
async function tokenFromServiceAccount(path) {
  const sa = JSON.parse(readFileSync(path, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`service-account token request failed (HTTP ${res.status})`);
  return json.access_token;
}

/** Access token from the gcloud CLI (user must have run `gcloud auth login`). */
function tokenFromGcloud() {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' };
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], opts).trim();
  } catch {
    throw new Error('could not get a token from gcloud. Run `gcloud auth login` (or set VERTEX_SERVICE_ACCOUNT_JSON).');
  }
}

const vertexToken = (env) =>
  env.VERTEX_SERVICE_ACCOUNT_JSON ? tokenFromServiceAccount(resolve(env.VERTEX_SERVICE_ACCOUNT_JSON)) : tokenFromGcloud();

function vertexBaseUrl(project, location) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

/** One-token probe per model so misconfigured ids are reported at setup time, not mid-demo. */
async function probeVertexModel(baseUrl, token, modelId) {
  try {
    const r = await http('POST', `${baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${token}` },
      body: { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
    });
    if (r.ok) return 'ok';
    return `HTTP ${r.status}: ${JSON.stringify(r.json).replace(/\s+/g, ' ').slice(0, 140)}`;
  } catch (e) {
    return `unreachable: ${errMsg(e)}`;
  }
}

/* ------------------------ Provider adapters (layer 2) ------------------------
 * Each adapter knows how to (a) detect its credentials in .env, (b) run a read-only
 * `check`, and (c) `discover` models as { id, context?, maxOutput?, tools? } records
 * (unknown metadata stays undefined and never disqualifies a model).
 * `type` is the TrueForge provider type: well-known ones carry catalog metadata,
 * `custom` ones are OpenAI-compatible endpoints we describe ourselves.
 */

const bearer = (key) => (key ? { authorization: `Bearer ${key}` } : {});

/** OpenAI-style GET {base}/models -> raw model entries. */
async function listOpenAI(base, headers) {
  return (await getOk(`${base}/models`, headers)).data ?? [];
}

const ADAPTERS = {
  anthropic: {
    type: 'anthropic',
    setup: (env) => (env.ANTHROPIC_API_KEY ? { key: env.ANTHROPIC_API_KEY } : null),
    headers: (c) => ({ 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }),
    async check(c) {
      await getOk('https://api.anthropic.com/v1/models?limit=1', this.headers(c));
    },
    async discover(c) {
      const out = [];
      let after;
      do {
        const q = new URLSearchParams({ limit: '100', ...(after ? { after_id: after } : {}) });
        const page = await getOk(`https://api.anthropic.com/v1/models?${q}`, this.headers(c));
        for (const m of page.data ?? []) {
          out.push({ id: m.id, context: m.max_input_tokens, maxOutput: m.max_tokens, tools: true });
        }
        after = page.has_more ? page.last_id : undefined;
      } while (after);
      return out;
    },
  },

  'google-gemini': {
    type: 'google-gemini',
    setup: (env) => (env.GEMINI_API_KEY ? { key: env.GEMINI_API_KEY } : null),
    headers: (c) => ({ 'x-goog-api-key': c.key }),
    async check(c) {
      await getOk('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', this.headers(c));
    },
    async discover(c) {
      const out = [];
      let token;
      do {
        const q = new URLSearchParams({ pageSize: '100', ...(token ? { pageToken: token } : {}) });
        const page = await getOk(`https://generativelanguage.googleapis.com/v1beta/models?${q}`, this.headers(c));
        for (const m of page.models ?? []) {
          if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
          out.push({
            id: m.name.replace(/^models\//, ''),
            context: m.inputTokenLimit,
            maxOutput: m.outputTokenLimit,
            tools: true,
          });
        }
        token = page.nextPageToken;
      } while (token);
      return out;
    },
  },

  openrouter: {
    type: 'custom',
    base: 'https://openrouter.ai/api/v1',
    setup: (env) => (env.OPENROUTER_API_KEY ? { key: env.OPENROUTER_API_KEY, base: 'https://openrouter.ai/api/v1' } : null),
    // /models is public on OpenRouter, so /key is the call that actually validates the key.
    async check(c) {
      await getOk(`${c.base}/key`, bearer(c.key));
    },
    async discover(c) {
      const raw = await listOpenAI(c.base, bearer(c.key));
      // Free-tier accounts (or accounts out of credit) can only use ':free' models.
      let restricted = false;
      try {
        const k = (await getOk(`${c.base}/key`, bearer(c.key))).data ?? {};
        restricted = k.is_free_tier === true || (k.limit != null && Number(k.limit_remaining) <= 0);
      } catch {
        /* key info is advisory */
      }
      c.freeTierOnly = restricted;
      return raw.map((m) => ({
        id: m.id,
        context: m.context_length,
        maxOutput: m.top_provider?.max_completion_tokens ?? undefined,
        tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
      }));
    },
  },

  groq: {
    type: 'custom',
    setup: (env) => (env.GROQ_API_KEY ? { key: env.GROQ_API_KEY, base: 'https://api.groq.com/openai/v1' } : null),
    async check(c) {
      await listOpenAI(c.base, bearer(c.key));
    },
    async discover(c) {
      return (await listOpenAI(c.base, bearer(c.key))).map((m) => ({
        id: m.id,
        context: m.context_window,
        maxOutput: m.max_completion_tokens,
      }));
    },
  },

  truefoundry: {
    type: 'custom',
    setup: (env) =>
      env.TRUEFOUNDRY_GATEWAY_BASE_URL && env.TRUEFOUNDRY_API_KEY
        ? { key: env.TRUEFOUNDRY_API_KEY, base: env.TRUEFOUNDRY_GATEWAY_BASE_URL.replace(/\/$/, '') }
        : null,
    async check(c) {
      await listOpenAI(c.base, bearer(c.key));
    },
    async discover(c) {
      return (await listOpenAI(c.base, bearer(c.key))).map((m) => ({ id: m.id, context: m.context_length ?? m.context_window }));
    },
  },

  ollama: {
    type: 'custom',
    setup: (env) => (env.OLLAMA_BASE_URL ? { key: '', base: env.OLLAMA_BASE_URL.replace(/\/$/, '') } : null),
    async check(c) {
      await listOpenAI(c.base, {});
    },
    async discover(c) {
      return (await listOpenAI(c.base, {})).map((m) => ({ id: m.id }));
    },
  },

  // Vertex has no simple model list: the policy's curated ids are probed instead.
  vertex: {
    type: 'custom',
    setup(env) {
      if (!env.VERTEX_PROJECT_ID) return null;
      return { env, base: vertexBaseUrl(env.VERTEX_PROJECT_ID, env.VERTEX_LOCATION || 'global') };
    },
    async check(c) {
      c.token = await vertexToken(c.env);
    },
    discover: null,
  },
};

/* ------------------------------ Policy (layer 3) ------------------------------ */

const toRegex = (p) => new RegExp(p, 'i');

/** TrueForge resource names: lowercase letters, digits and hyphens only. */
function toResourceName(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * Applies a provider policy to its discovered models.
 * Returns { chosen: [record], warnings: [string] }.
 */
function selectModels(pol, discovered, freeTierOnly) {
  const warnings = [];
  const max = pol.max_models ?? DEFAULT_MAX_MODELS;
  const byId = new Map(discovered.map((m) => [m.id, m]));

  if (pol.mode === 'pinned') {
    const chosen = [];
    for (const id of pol.models ?? []) {
      const found = byId.get(id);
      if (!found) warnings.push(`pinned "${id}" not reported by provider; skipped`);
      else chosen.push(found);
    }
    if (chosen.length > max) warnings.push(`capped at max_models=${max}`);
    return { chosen: chosen.slice(0, max), warnings };
  }

  // discover: include/exclude patterns, requirements, free-tier restriction, then rank.
  const include = (pol.include ?? []).map(toRegex);
  const exclude = (pol.exclude ?? []).map(toRegex);
  const req = pol.requirements ?? {};
  let pool = discovered.filter((m) => {
    if (include.length && !include.some((r) => r.test(m.id))) return false;
    if (exclude.some((r) => r.test(m.id))) return false;
    if (req.tools && m.tools === false) return false;
    if (req.min_context && m.context != null && m.context < req.min_context) return false;
    return true;
  });
  if (freeTierOnly && pol.free_tier_suffix) {
    pool = pool.filter((m) => m.id.endsWith(pol.free_tier_suffix));
    warnings.push(`free tier or no credits: restricted to "${pol.free_tier_suffix}" models`);
  }
  if ((pol.prefer ?? 'context') === 'context') pool.sort((a, b) => (b.context ?? 0) - (a.context ?? 0));
  if (pool.length > max) warnings.push(`${pool.length} matched, capped at max_models=${max}`);
  return { chosen: pool.slice(0, max), warnings };
}

/* -------------------------- Planning + registration -------------------------- */

/** Builds a TrueForge model entry: discovery properties, overridden by catalog data when known. */
function buildModel(rec, alias, catalogModels, usedNames) {
  const cat = catalogModels.find((m) => m.model_id === rec.id);
  const properties = {};
  if (rec.context) properties.context_length = rec.context;
  if (rec.maxOutput) properties.max_output_tokens = rec.maxOutput;
  Object.assign(properties, cat?.properties);
  if (!properties.context_length) properties.context_length = 128000;
  if (!properties.max_output_tokens) properties.max_output_tokens = 8192;
  let name = toResourceName(alias || cat?.name || rec.id);
  for (let i = 2; usedNames.has(name); i++) name = `${toResourceName(alias || cat?.name || rec.id)}-${i}`;
  usedNames.add(name);
  return { model_id: rec.id, name, properties };
}

/** Runs discovery + policy for one provider. Returns a result row (never throws). */
async function planProvider(name, adapter, creds, pol, catalog) {
  const row = { name, discovered: '-', selected: 0, models: [], warnings: [], status: 'planned', manifest: null };
  try {
    let discovered;
    if (adapter.discover) {
      discovered = await adapter.discover(creds);
      row.discovered = discovered.length;
    } else {
      // Vertex: curated ids from policy, each verified with a probe (skipped in dry runs).
      creds.token = await vertexToken(creds.env);
      discovered = [];
      for (const id of pol.models ?? []) {
        const result = DRY ? 'not probed (dry run)' : await probeVertexModel(creds.base, creds.token, id);
        if (result === 'ok' || DRY) discovered.push({ id, context: 1000000, maxOutput: 65536, tools: true });
        else row.warnings.push(`probe ${id}: ${result}`);
      }
      row.discovered = DRY ? 'n/a' : discovered.length;
    }

    const effective = name === 'vertex' ? { ...pol, mode: 'pinned' } : pol;
    const { chosen, warnings } = selectModels(effective, discovered, creds.freeTierOnly);
    row.warnings.push(...warnings);
    row.selected = chosen.length;
    if (!chosen.length) {
      row.status = 'nothing selected';
      return row;
    }

    // Well-known types enrich from TrueForge's catalog; Vertex borrows the Gemini entries.
    const catType = name === 'vertex' ? 'google-gemini' : adapter.type;
    const catalogModels = catalog.find((p) => p.type === catType)?.models ?? [];
    const aliases = pol.aliases ?? {};
    const used = new Set();
    const models = chosen.map((rec) => {
      const lookup = name === 'vertex' ? { ...rec, id: rec.id.replace(/^google\//, '') } : rec;
      const m = buildModel(lookup, aliases[rec.id] || (name === 'vertex' ? lookup.id : undefined), catalogModels, used);
      m.model_id = rec.id; // upstream id is what the provider receives
      return m;
    });
    row.models = models.map((m) => `${name}/${m.name}`);
    row.manifest =
      adapter.type === 'custom'
        ? {
            type: 'custom',
            name,
            base_url: creds.base,
            ...(creds.token || creds.key ? { auth: { api_key: creds.token || creds.key } } : {}),
            models,
          }
        : { type: adapter.type, auth: { api_key: creds.key }, models };
  } catch (e) {
    row.status = `FAIL: ${errMsg(e)}`;
  }
  return row;
}

async function register(row) {
  let r = await tf('POST', '/settings/model-providers', { manifest: row.manifest });
  if (r.status === 409) r = await tf('PUT', '/settings/model-providers', { manifest: row.manifest });
  if (r.status >= 200 && r.status < 300) {
    row.status = 'registered';
  } else {
    row.status = `FAIL: HTTP ${r.status} ${String(r.json?.error?.message ?? JSON.stringify(r.json)).slice(0, 160)}`;
  }
}

function printTable(rows) {
  const head = ['provider', 'discovered', 'selected', 'registered model names', 'status'];
  const body = rows.map((r) => [r.name, String(r.discovered), String(r.selected), r.models.join(', ') || '-', r.status]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const b of body) console.log(fmt(b));
  for (const r of rows) for (const w of r.warnings) console.log(`! ${r.name}: ${w}`);
}

async function main() {
  const env = parseEnv(ENV_PATH);
  const policy = loadPolicy(POLICY_PATH);

  // Resolve which providers are in play: enabled in policy AND credentials present.
  const active = [];
  const skipped = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    const pol = policy[name];
    if (!pol || pol.enabled === false) {
      skipped.push({ name, discovered: '-', selected: 0, models: [], warnings: [], status: 'skipped (disabled in policy)' });
      continue;
    }
    const creds = adapter.setup(env);
    if (!creds) {
      const why = name === 'vertex' ? 'VERTEX_PROJECT_ID is empty' : 'no credentials in .env';
      skipped.push({ name, discovered: '-', selected: 0, models: [], warnings: [], status: `skipped (${why})` });
      continue;
    }
    active.push({ name, adapter, creds, pol });
  }

  if (CHECK) {
    console.log('Key check (read-only; nothing is registered):');
    const rows = [];
    for (const { name, adapter, creds } of active) {
      let status;
      try {
        await adapter.check(creds);
        status = 'OK';
      } catch (e) {
        status = `FAIL: ${errMsg(e)}`;
      }
      rows.push({ name, status });
    }
    for (const s of skipped) rows.push({ name: s.name, status: s.status });
    const w = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`  ${r.name.padEnd(w)}  ${r.status}`);
    return;
  }

  const health = await fetch(`${BASE}/`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`TrueForge is not reachable at ${BASE}. Start it first: scripts/start-trueforge.(sh|ps1)`);
    process.exit(1);
  }
  const catalog = (await tf('GET', '/catalogs/model-providers')).json.data ?? [];

  for (const name of REMOVE) {
    if (DRY) {
      console.log(`- would remove ${name}`);
      continue;
    }
    const r = await tf('DELETE', `/settings/model-providers/${encodeURIComponent(name)}`);
    console.log(`- removed ${name}: HTTP ${r.status}`);
  }

  const rows = [];
  for (const { name, adapter, creds, pol } of active) {
    const row = await planProvider(name, adapter, creds, pol, catalog);
    if (row.manifest) {
      if (DRY) row.status = 'dry-run (not registered)';
      else await register(row);
    }
    rows.push(row);
  }
  rows.push(...skipped);

  console.log(`\n${DRY ? 'Plan (dry run)' : 'Result'}:`);
  printTable(rows);

  if (!DRY) {
    const all = (await tf('GET', '/models')).json.data ?? [];
    console.log(`\nModels available in TrueForge (${all.length}):`);
    for (const m of all) console.log(`  ${m.name}`);
    console.log('\nUse these names in the Temper model router (setting: temper.models.chain).');
  }
}

main()
  .then(() => {
    if (!WATCH || CHECK) return;
    console.log('\nWatching: re-running every 45 minutes to refresh the Vertex AI token (Ctrl+C to stop).');
    setInterval(() => {
      console.log(`\n[${new Date().toLocaleTimeString()}] refreshing providers`);
      main().catch((e) => console.error(`refresh failed: ${errMsg(e)}`));
    }, REFRESH_MS);
  })
  .catch((e) => {
    console.error(`register-providers failed: ${errMsg(e)}`);
    process.exit(1);
  });

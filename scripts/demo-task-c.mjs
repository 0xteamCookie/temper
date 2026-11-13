#!/usr/bin/env node
// Copyright 2026 The Temper Authors. SPDX-License-Identifier: Apache-2.0
//
// Resilience demo helper (fixed Task C). Registers a model provider in the
// local TrueForge whose endpoint is unreachable, so it can be placed first in
// Temper's model chain to show automatic fallback. Nothing here touches the
// workspace or any real provider credentials.
//
//   node scripts/demo-task-c.mjs break     # add provider "unreachable" (model: unreachable/primary)
//   node scripts/demo-task-c.mjs restore   # remove it again
//
// Options: --base http://127.0.0.1:8790

const args = process.argv.slice(2);
const action = args[0];
const i = args.indexOf('--base');
const BASE = (i >= 0 && args[i + 1] ? args[i + 1] : 'http://127.0.0.1:8790').replace(/\/$/, '');
const NAME = 'unreachable';
// An unused loopback port: nothing listens there, so connections are refused immediately.
const DEAD_URL = 'http://127.0.0.1:59999/v1';

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (action === 'break') {
    const manifest = {
      type: 'custom',
      name: NAME,
      base_url: DEAD_URL,
      auth: { api_key: 'not-a-real-key' },
      models: [
        {
          model_id: 'primary',
          name: 'primary',
          properties: { context_length: 128000, max_output_tokens: 8192 },
        },
      ],
    };
    let r = await api('POST', '/settings/model-providers', { manifest });
    if (r.status === 409) r = await api('PUT', '/settings/model-providers', { manifest });
    if (r.status >= 300) throw new Error(`could not register provider: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    console.log(`Registered "${NAME}/primary" -> ${DEAD_URL} (unreachable).`);
    console.log('Put it first in the Temper model chain (Models section or temper.models.chain),');
    console.log('then run Task A. Temper should fall back to the next model automatically.');
  } else if (action === 'restore') {
    const r = await api('DELETE', `/settings/model-providers/${NAME}`);
    console.log(r.status < 300 ? `Removed "${NAME}".` : `Nothing to remove (HTTP ${r.status}).`);
    console.log('Remember to take it out of temper.models.chain as well.');
  } else {
    console.log('Usage: node scripts/demo-task-c.mjs break|restore');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`demo-task-c failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

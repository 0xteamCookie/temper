# Configuration

The primary way to add a model provider is the **Providers** screen in the Temper panel (Models view): keys are typed into a VS Code prompt, models are discovered and picked there, and the result is saved straight into TrueForge. Nothing in this folder is needed for that.

## Headless / CI setup

For CI and scripted setups, model provisioning is split into four layers, each with one job:

1. **Secrets** - `.env` (git-ignored, template in `.env.example`). API keys and environment-specific endpoints/ids only. No model lists.
2. **Discovery** - `scripts/register-providers.mjs` asks each enabled provider for the models your key can actually use (Anthropic, Gemini, OpenRouter, Groq, TrueFoundry, Ollama). Vertex AI has no simple list, so the policy's curated ids are probed instead. Well-known providers are enriched from TrueForge's catalog (context length, output limit, reasoning efforts).
3. **Policy** - `providers.json` (committed, no secrets). Decides which discovered models to use.
4. **Registration** - the script registers the selection in TrueForge (POST, then PUT on conflict) and prints a summary table.

```bash
node scripts/register-providers.mjs --check    # validate each key, read-only
node scripts/register-providers.mjs --dry-run  # discover + select, register nothing
node scripts/register-providers.mjs            # register
node scripts/register-providers.mjs --remove mock,ollama-local   # explicit cleanup only
```

Other flags: `--watch` (re-run every 45 min to refresh the Vertex token), `--env`, `--policy`, `--base`.

## providers.json

Per provider (keyed by name: `anthropic`, `google-gemini`, `vertex`, `openrouter`, `groq`, `truefoundry`, `ollama`):

| Field                 | Meaning                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `false` skips the provider. A provider is also skipped when its credentials are missing from `.env`.                                                                                              |
| `mode`                | `pinned`: use exactly the ids in `models`; ids the provider does not report are warned and skipped. `discover`: pick from the provider's list using the filters below. (Vertex is always pinned.) |
| `models`              | Pinned model ids (upstream ids, e.g. `claude-sonnet-5-5`).                                                                                                                                        |
| `include` / `exclude` | Case-insensitive regex patterns tested against model ids (discover mode).                                                                                                                         |
| `requirements`        | `tools: true` drops models known not to support tool calling; `min_context` drops models with a smaller known context. Unknown metadata never disqualifies a model.                               |
| `free_tier_suffix`    | OpenRouter: when the key is on the free tier or out of credits, only ids ending in this suffix (`:free`) qualify.                                                                                 |
| `prefer`              | `context` (default) ranks by largest context window first.                                                                                                                                        |
| `max_models`          | Cap on registered models for the provider (default 3).                                                                                                                                            |
| `aliases`             | Optional `{ "<model id>": "<name>" }` display names. Names are sanitized to TrueForge resource names (lowercase letters, digits, hyphens).                                                        |

## Temper settings

`models.example.json` shows a model fallback chain. It contains no secrets and maps onto VS Code settings:

| Example field      | VS Code setting                  |
| ------------------ | -------------------------------- |
| `chain`            | `temper.models.chain`            |
| `agentMode`        | `temper.models.agentMode`        |
| `inlineEdit`       | `temper.models.inlineEdit`       |
| `fallback.enabled` | `temper.models.fallback.enabled` |
| `fallback.retries` | `temper.models.fallback.retries` |

Model names must match what TrueForge reports at `GET /api/v1/models` (`<provider>/<alias>`). Keys never go in this folder or in VS Code settings.

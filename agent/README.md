# Agent specs

This folder holds the TrueForge agent specifications used by Temper.

| File                 | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `temper-agent.json`  | Main agent for agent mode (multi-file tasks, with a read-only scout subagent) |
| `temper-inline.json` | Short-lived agent for inline edits on a selection                             |

## How they are loaded

1. When the extension connects to TrueForge, and again when a mode's model changes, it reads the spec from `temper.trueforge.agent` / `temper.trueforge.inlineAgent`. When those settings are empty it uses the copy bundled with the extension.
2. The extension fills in the model (`model.name`) from the configured chain and the MCP server entry for its local server (`http://127.0.0.1:<port>/mcp`), then registers the spec as a named agent (`POST /api/v1/agents`, or `PUT` when it exists) and creates the session by name with `POST /api/v1/sessions`. TrueForge has no per-session model override, so the agent's model is updated before each session and each fallback attempt. If registration fails, the session is created from the inline spec instead.
3. Tools that change state, such as `submit_changeset`, are listed in `require_approval_for_tools`, so TrueForge pauses the turn until the user allows or denies in the review UI. With `temper.review.mode` set to `perEdit`, the extension adds `propose_edit` and `create_file` to that list.
4. The MCP server is listed with `preload: false`, so its tools are deferred and loaded on demand. The inline spec preloads `read_file`, `find_symbol`, `propose_edit` and `submit_changeset`.

Specs contain no model keys and no absolute paths. Models are resolved by name in TrueForge.

The agents appear in TrueForge under Agents as `temper-agent` and `temper-inline`. The `${MODEL}` placeholder is not a valid model name, so posting these files with `curl` fails; Temper registers them automatically.

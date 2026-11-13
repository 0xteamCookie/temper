# Agent specs

This folder holds the TrueForge agent specifications used by Temper.

| File                 | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `temper-agent.json`  | Main agent for agent mode (multi-file tasks, with a read-only scout subagent) |
| `temper-inline.json` | Short-lived agent for inline edits on a selection                             |

Status: the spec files are added together with the TrueForge integration. This README documents the contract.

## How they are loaded

1. On a new session the extension reads the spec from `temper.trueforge.agent` / `temper.trueforge.inlineAgent`. When those settings are empty it uses the copy bundled with the extension.
2. The extension fills in the model (`model.name`) from the configured chain and the MCP server entry for its local server (`http://127.0.0.1:<port>/mcp`), then creates the session with `POST /api/v1/sessions` as an inline spec.
3. Tools that change state, such as `submit_changeset`, are listed in `require_approval_for_tools`, so TrueForge pauses the turn until the user allows or denies in the review UI.

Specs contain no model keys and no absolute paths. Models are resolved by name in TrueForge.

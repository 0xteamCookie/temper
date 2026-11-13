# Temper

**A safety-first coding agent for VS Code, built on TrueForge.**

[![CI](https://github.com/0xteamCookie/temper/actions/workflows/ci.yml/badge.svg)](https://github.com/0xteamCookie/temper/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.100.0-007ACC.svg)](https://code.visualstudio.com/)

Temper is a VS Code extension that lets a coding agent read, search and edit your project while keeping you in control of every change. The agent loop runs on TrueForge, TrueFoundry's open-source agent harness, running locally. Temper exposes editor capabilities to it as MCP tools served over HTTP on `127.0.0.1`. The extension never calls a model provider directly.

> Status: early scaffold. See [Features](#features) for what exists today.

## Why Temper

- **Context Ledger.** Shows which code the agent chose to look at, why it chose it, and what each piece costs in tokens against a budget you control.
- **Scope Fence.** Flags edits that fall outside what you asked for (for an inline edit, outside your selection) and rejects them by default in review.
- **Symbol Check.** Catches edits that reference functions, classes or variables that do not exist in your workspace, and sends them back to the agent before you see them.
- **Nothing touches disk until you accept.** Proposed changes live in memory as a changeset. You accept or reject them hunk by hunk.
- **Checkpoint undo.** Every accepted change is recorded so you can roll back the last agent change with one command.
- **Automatic model fallback.** If a model request fails, Temper retries and then moves to the next model in your chain. A failed attempt never modifies your workspace.

## Features

| Area                                                      | Status      |
| --------------------------------------------------------- | ----------- |
| Extension scaffold, settings, commands, panel view        | In progress |
| TrueForge client (sessions, streaming, cancel, approvals) | In progress |
| MCP tool server on `127.0.0.1`                            | In progress |
| Changeset overlay, hunk review, checkpoints               | In progress |
| Scope Fence and Symbol Check                              | In progress |
| Context Ledger and budgeted context packs                 | Planned     |
| Inline edit (`Ctrl+Alt+K`) with per-hunk Accept/Reject    | Planned     |
| Model chain with automatic fallback                       | Planned     |
| Allowlisted commands in a shadow worktree                 | Planned     |
| Provider registration script                              | Planned     |

## Architecture

```
 VS Code extension                                          TrueForge (local, pinned)
 +---------------------------------------------+  SDK/SSE  +------------------------------+
 | Panel (React webview): chat, tool timeline,  |---------->| sessions, turns, streaming   |
 |   Context Ledger, review                     |<--events--| approvals, subagents         |
 | Inline edit: diff + per-hunk CodeLens        |           | tool calling, compaction     |
 | Model chain, health, automatic fallback      |           +--------------+---------------+
 | MCP server (127.0.0.1:<port>/mcp)  <---------+-------------------------+ MCP (HTTP)
 |   read_file, list_dir, search_code,          |     Models are configured ONLY in TrueForge
 |   find_symbol, get_context, propose_edit,    |     (Anthropic, Gemini, OpenRouter, Groq,
 |   submit_changeset, run_command              |      TrueFoundry gateway, Ollama, ...)
 | Changeset overlay (in memory) -> hunks ->    |
 |   accept -> WorkspaceEdit + checkpoint       |
 | Guards: Scope Fence, Symbol Check            |
 | Context engine, shadow worktree              |
 +---------------------------------------------+
```

More detail in [docs/architecture.md](docs/architecture.md).

## Quickstart

Prerequisites: Node.js >= 22.14, VS Code >= 1.100, git. Python 3.10+ is needed only for the Flask demo project.

```bash
git clone https://github.com/0xteamCookie/temper.git
cd temper
npm ci

cp .env.example .env        # then fill in the provider keys you want to use

scripts/start-trueforge.sh  # or scripts/start-trueforge.ps1 on Windows
scripts/register-providers  # coming soon: registers providers from .env with TrueForge
```

The first TrueForge start downloads the package via `npx` and can take a minute or two. The script waits until the server answers on `http://127.0.0.1:8790/`.

Then open the folder in VS Code and press `F5`, choosing the **Run Temper Extension** launch configuration. The Temper icon appears in the activity bar of the Extension Development Host window.

Optional demo project: `scripts/setup-flask-demo.sh [path]` clones Flask 3.1.3 and prepares a virtual environment (default path `../flask`).

## Configuration

All settings live under `temper.*`.

| Setting                               | Default                                                 | Description                                       |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `temper.trueforge.baseUrl`            | `http://127.0.0.1:8790`                                 | TrueForge server root                             |
| `temper.trueforge.agent`              | `""`                                                    | Agent spec for agent mode (empty = bundled)       |
| `temper.trueforge.inlineAgent`        | `""`                                                    | Agent spec for inline edits (empty = bundled)     |
| `temper.models.chain`                 | `[]`                                                    | Ordered fallback chain of TrueForge model names   |
| `temper.models.agentMode`             | `""`                                                    | Model for agent mode (empty = first in chain)     |
| `temper.models.inlineEdit`            | `""`                                                    | Model for inline edits (empty = first in chain)   |
| `temper.models.fallback.enabled`      | `true`                                                  | Fall back to the next model on failure            |
| `temper.models.fallback.retries`      | `1`                                                     | Retries on the same model before falling back     |
| `temper.context.budgetTokens`         | `0`                                                     | Context token budget (`0` = adaptive)             |
| `temper.context.budgetPercent`        | `25`                                                    | Share of the model window used when adaptive      |
| `temper.context.exclude`              | `.git, node_modules, dist, out, .venv, __pycache__`     | Excluded from indexing and context                |
| `temper.review.mode`                  | `endOfRun`                                              | `endOfRun` or `perEdit`                           |
| `temper.commands.allowlist`           | `pytest, python -c, git diff, git status, flask --help` | Command prefixes the agent may run                |
| `temper.commands.runInShadowWorktree` | `true`                                                  | Run commands in a throwaway copy of the workspace |
| `temper.guards.scopeFence`            | `flagAndReject`                                         | `flagAndReject`, `block`, `warn`, `off`           |
| `temper.guards.symbolCheck`           | `bounceThenWarn`                                        | `bounceThenWarn`, `bounce`, `warn`, `off`         |
| `temper.mcp.port`                     | `0`                                                     | MCP server port (`0` = automatic)                 |
| `temper.ui.showLedger`                | `true`                                                  | Show the Context Ledger in the panel              |

## Models

Bring your own. Models and their API keys are configured only in TrueForge. Temper settings hold model names (for example `provider/model`) and never keys. See [config/README.md](config/README.md) for an example chain.

## Starting point

Built from scratch. Small, attributed snippets and design patterns come from OpenCode, Cline and Continue; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Project status

Round 1 entry for the TrueFoundry Forge-a-thon, Techfest IIT Bombay 2026-27.

## Team

`teamDelulutoSolulu()`: [0xPixelNinja](https://github.com/0xPixelNinja), [pranjal-kumar-0](https://github.com/pranjal-kumar-0), [Kathrina-dev](https://github.com/Kathrina-dev).

## Contributing, security, license

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md)
- Security: [SECURITY.md](SECURITY.md)
- License: [Apache-2.0](LICENSE); third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

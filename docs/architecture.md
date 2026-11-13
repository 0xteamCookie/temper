# Architecture

Temper is a VS Code extension. The agent loop (model calls, tool calling, streaming, approvals) runs in TrueForge, TrueFoundry's open-source harness, started locally. Temper provides the editor side: tools the agent can call, a review layer for its changes, and the UI.

```
 VS Code extension                                          TrueForge (local, pinned)
 +---------------------------------------------+  SDK/SSE  +------------------------------+
 | Panel (React webview)                        |---------->| sessions, turns, streaming   |
 | Inline edit controller                       |<--events--| approvals, subagents         |
 | Model chain and fallback                     |           +--------------+---------------+
 | MCP server (127.0.0.1:<port>/mcp)  <---------+-------------------------+ MCP (HTTP)
 | Changeset overlay, guards, context engine    |     Models are configured only in TrueForge
 +---------------------------------------------+
```

## Components

| Folder                    | Responsibility                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `extension/src/trueforge` | Client for the TrueForge HTTP API: sessions, turns, SSE streaming, cancel, approvals, model chain and fallback |
| `extension/src/mcp`       | MCP server over HTTP on `127.0.0.1` exposing editor tools to the agent                                         |
| `extension/src/context`   | Indexing, retrieval, token budgeting and the Context Ledger                                                    |
| `extension/src/changeset` | In-memory overlay of proposed edits, hunks, apply, checkpoints, shadow worktree                                |
| `extension/src/guards`    | Scope Fence and Symbol Check                                                                                   |
| `extension/src/inline`    | Inline edit controller, decorations and CodeLens                                                               |
| `extension/src/review`    | Multi-file review                                                                                              |
| `extension/src/config`    | Typed access to `temper.*` settings                                                                            |
| `extension/webview-ui`    | React and Vite panel                                                                                           |
| `agent/`                  | TrueForge agent specs                                                                                          |

## MCP tools

The extension serves these tools: `read_file`, `list_dir`, `search_code`, `find_symbol`, `get_context`, `propose_edit`, `submit_changeset`, `run_command`. Read-only tools run without approval. `submit_changeset` is gated by a TrueForge approval, which opens the review UI.

## Flows

**Agent mode.** The user's request starts a TrueForge session with the main agent. The agent explores with read-only tools and calls `get_context`, which returns a budgeted pack and fills the Context Ledger. It records edits with `propose_edit` into the in-memory changeset, optionally runs allowlisted commands in a shadow worktree, then calls `submit_changeset`. The turn pauses for approval; accepting applies only the accepted hunks through a `WorkspaceEdit` and records a checkpoint. Denying sends the reason back to the agent.

**Inline edit.** The user selects code and runs `Temper: Edit Selection` (`Ctrl+Alt+K`). A short session runs with the inline agent spec. Proposed edits stream into an inline diff with per-hunk Accept and Reject. Scope Fence marks hunks outside the selection.

**Cancel.** The extension cancels the TrueForge session and discards the overlay, or offers a partial review. Disk is untouched before an accept.

**Fallback.** A failed model turn is retried according to `temper.models.fallback.retries`, then replayed on the next model in `temper.models.chain`. A failed turn has produced no workspace changes, so replay is safe.

## Safety model

- Proposed edits live in memory. The workspace changes only when the user accepts a hunk.
- Every accepted change is checkpointed and can be undone with `Temper: Undo Last Agent Change`.
- Scope Fence compares each edit with the requested scope. Symbol Check resolves identifiers in proposed code against the workspace and returns unresolved ones to the agent.
- Agent-run commands are limited to `temper.commands.allowlist` and can run in a throwaway copy of the workspace.
- The MCP server and TrueForge both bind to `127.0.0.1`. TrueForge is started with an outbound allowlist containing only `127.0.0.1`.
- Model API keys exist only in TrueForge.

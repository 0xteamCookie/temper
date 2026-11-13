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
| `extension/src/changeset` | In-memory overlay of proposed edits, fuzzy edit matching, hunks, apply and checkpoints                         |
| `extension/src/host`      | Wiring: run controller, edit tools, command policy, shadow worktree, agent specs, TrueForge connection         |
| `extension/src/guards`    | Scope Fence and Symbol Check                                                                                   |
| `extension/src/inline`    | Inline edit: in-buffer diff, decorations and per-hunk CodeLens                                                 |
| `extension/src/review`    | Multi-file review: diff tabs for proposed content                                                              |
| `extension/src/config`    | Typed access to `temper.*` settings                                                                            |
| `extension/webview-ui`    | React and Vite panel: chat, Context Ledger, Review and Models views                                            |
| `agent/`                  | TrueForge agent specs                                                                                          |

## MCP tools

The extension serves these tools: `read_file`, `list_dir`, `search_code`, `find_symbol`, `get_context`, `propose_edit`, `create_file`, `submit_changeset`, `run_command`. `submit_changeset` is gated by a TrueForge approval (`require_approval_for_tools` in the agent spec), which opens the review. With `temper.review.mode` set to `perEdit`, `propose_edit` and `create_file` are gated as well. The agent specs register the server as `temper` and mark its tools as deferred (`preload: false`); the inline spec preloads four of them.

## Flows

**Agent mode.** The user's request starts a TrueForge session from the named agent `temper-agent`, which the extension registers on connect (with `temper-inline` for inline edits). The agent explores with read-only tools and calls `get_context`, which returns a budgeted pack and fills the Context Ledger. It records edits with `propose_edit` into the in-memory changeset, optionally runs allowlisted commands in a shadow worktree, then calls `submit_changeset`. The turn pauses for approval; accepting applies only the accepted hunks through a `WorkspaceEdit` and records a checkpoint. Denying sends the reason back to the agent.

**Inline edit.** The user selects code and runs `Temper: Edit Selection` (`Ctrl+Alt+K`). A short session runs with the inline agent spec. Proposed lines are shown in the editor buffer directly below the lines they replace, without saving; each hunk has Accept and Reject, and the temporary lines are removed before anything is applied. Scope Fence marks hunks outside the selection.

**Cancel.** The extension cancels the TrueForge session and discards the overlay, or offers a partial review. Disk is untouched before an accept.

**Fallback.** A failed model turn is retried according to `temper.models.fallback.retries`, then replayed on the next model in `temper.models.chain`. A failed turn has produced no workspace changes, so replay is safe.

## Safety model

- Proposed edits live in memory. The workspace changes only when the user accepts a hunk.
- Every accepted change is checkpointed and can be undone with `Temper: Undo Last Agent Change`.
- Scope Fence compares each edit with the requested scope. Symbol Check resolves identifiers in proposed code against the workspace and returns unresolved ones to the agent.
- Agent-run commands are limited to `temper.commands.allowlist` and can run in a throwaway copy of the workspace.
- The MCP server and TrueForge both bind to `127.0.0.1`. TrueForge is started with an outbound allowlist containing only `127.0.0.1`.
- Model API keys exist only in TrueForge.

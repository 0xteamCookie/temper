# Temper

A safety-first coding agent for VS Code. Its agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge) in local mode; Temper serves the editor's capabilities to the agent as MCP tools and shows every change for per-hunk review before anything is written.

## Requirements

- VS Code 1.100 or newer
- Node.js 22 or newer (TrueForge runs through `npx`)
- An API key for any model provider, or any OpenAI-compatible endpoint

## Getting started

1. Open the **Temper** view from the activity bar.
2. Temper starts TrueForge for you. If nothing is listening on `http://127.0.0.1:8790`, it runs the pinned release (`npx -y @truefoundry/trueforge@0.185.0`) as a background process with the settings it needs, keeps its data in VS Code's extension storage, shows its log in the **Temper** output channel and stops it when VS Code closes. The first start downloads the package and can take a minute or two. Set `temper.trueforge.autoStart` to `false` to manage TrueForge yourself.
3. Open **Settings → Providers**, add a provider and its key, and pick a model. The key is sent to TrueForge, which stores it; Temper keeps no copy.

If you start TrueForge yourself, Temper uses it as is. Set `HOST` (TrueForge's default, `localhost`, resolves to `::1` on many Linux systems) and `OUTBOUND_URL_ALLOWED_HOSTS` (so it can reach Temper's MCP server):

```powershell
# PowerShell
$env:HOST='127.0.0.1'; $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx -y @truefoundry/trueforge@0.185.0
```

```sh
# bash / zsh
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx -y @truefoundry/trueforge@0.185.0
```

## Using Temper

- **Agent mode:** describe a change in the panel. The agent finds the files, stages edits, and opens a per-hunk review.
- **Inline edit:** select code and press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS).
- **Context Ledger:** shows which files were chosen for the model, why, and their token cost.

Full documentation, architecture and source: https://github.com/0xteamCookie/temper

# Contributing to Temper

Thanks for helping. This guide covers setup, day-to-day workflow and conventions. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Node.js >= 22.14 (see `.nvmrc`), npm 10+, git, VS Code >= 1.100.

```bash
git clone https://github.com/0xteamCookie/temper.git
cd temper
npm ci
cp .env.example .env     # never commit .env
```

## Running and debugging (F5)

1. Start TrueForge: `scripts/start-trueforge.sh` (or `.ps1` on Windows).
2. Open the repo in VS Code and press `F5` with **Run Temper Extension** selected. This builds the extension and opens an Extension Development Host.
3. Set breakpoints in `extension/src`; source maps are enabled.

`scripts/stop-trueforge.sh` (or `.ps1`) stops the local server.

## Scripts

| Command             | Purpose                             |
| ------------------- | ----------------------------------- |
| `npm run build`     | Build the extension and the webview |
| `npm run watch`     | Rebuild on change                   |
| `npm run lint`      | ESLint across the repo              |
| `npm run typecheck` | TypeScript type checking            |
| `npm test`          | Unit tests (Vitest)                 |
| `npm run format`    | Format with Prettier                |
| `npm run package`   | Produce a `.vsix`                   |

## Branches and commits

- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`, `refactor/<topic>`, `test/<topic>`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(mcp): add find_symbol tool`, `fix(changeset): handle CRLF hunks`.
- Keep commits focused; squash noise before opening a PR.

## Pull request checklist

- [ ] `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass locally
- [ ] New behaviour has tests
- [ ] Settings changes are reflected in `extension/package.json`, `extension/src/config/settings.ts` and the README table
- [ ] Code adopted from another project is attributed in `THIRD_PARTY_NOTICES.md` and in the file header
- [ ] No secrets, keys or personal data in the diff
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes

## Coding standards

- TypeScript in `strict` mode; no `any` without a comment explaining why.
- Use `import type` for type-only imports. Unused parameters start with `_`.
- Nothing writes to the workspace except through the changeset apply path after the user accepts.
- The extension never calls model providers; all model traffic goes through TrueForge.
- The MCP server binds to `127.0.0.1` only.
- Formatting is handled by Prettier; do not hand-format.

## Adding an MCP tool

1. Create the tool in `extension/src/mcp/` with a flat input schema (zod) and a description that states the failure messages and what to do about them.
2. Mark read-only tools with the `readOnlyHint` annotation. Tools that propose or apply changes must go through the changeset layer, never write files directly.
3. Register the tool with the MCP server and add it to the tool list in `docs/architecture.md`.
4. If the tool should be gated by approval, add it to `require_approval_for_tools` in the relevant spec under `agent/`.
5. Add unit tests under `extension/test/`.

## Third-party code

Only adopt code under a compatible licence (MIT, Apache-2.0, BSD). Keep the upstream copyright, add a header naming the source repo, ref and licence, and add a row to the "Files derived" table in `THIRD_PARTY_NOTICES.md`.

# Security Policy

## Supported versions

Temper is pre-release. Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include a description, reproduction steps and the affected version or commit.

We aim to acknowledge reports within a few days and will coordinate a fix and disclosure with you.

## Secrets policy

- Model provider keys are configured only in TrueForge. They are never stored in VS Code settings and never committed.
- `.env` and `.trueforge/` are git-ignored; the local TrueForge database can contain provider keys. Do not share it.
- `.env.example` must only contain empty values or local placeholders.
- If you believe a key was committed, rotate it immediately and report it.

## Design notes

- The extension's MCP server binds to `127.0.0.1` only.
- TrueForge runs locally and is restricted to `127.0.0.1` for outbound MCP registration.
- Agent-run commands are limited to an allowlist and can run in a throwaway worktree.
- Proposed edits are applied only after explicit user acceptance.

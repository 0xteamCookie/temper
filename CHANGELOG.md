# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- TrueForge client with streaming, cancel and approvals; MCP tool server on `127.0.0.1`.
- Changeset overlay with per-hunk review and checkpoint undo.
- Scope Fence and Symbol Check guards.
- Context Ledger and budgeted retrieval.
- Inline edit (`Ctrl+Alt+K`) with per-hunk accept/reject.
- Model chain with automatic fallback.
- Allowlisted commands run in a shadow copy of the workspace.
- Provider registration script (`node scripts/register-providers.mjs`).
- Third-party notices for adopted code and design credits.

### Fixed

- Staging an edit no longer drops flags and decisions of unchanged hunks.
- Closing a review closes its diff tabs.
- No applied/rejected toast when nothing was applied or rejected.

### Initial

- Initial scaffold: VS Code extension skeleton, settings, commands, activity bar panel, build, lint, test and CI tooling, TrueForge helper scripts and documentation.

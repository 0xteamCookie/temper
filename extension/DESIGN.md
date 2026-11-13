# Design

Temper's panel is a VS Code webview (`extension/webview-ui`, React 19). It must feel built into VS Code and sit visually next to TrueForge's console. Product context lives in `PRODUCT.md`.

## Surfaces and colour

Restrained strategy: VS Code theme surfaces carry everything, plus **one indigo accent** (TrueForge's primary) used only for the primary action, live activity, current selection and focus.

| Token | Value | Use |
|---|---|---|
| `--t-bg` | `--vscode-sideBar-background` | panel ground |
| `--t-surface` | `--vscode-editorWidget-background` | raised blocks (user message, review files, popovers) |
| `--t-input` | `--vscode-input-background` | composer box |
| `--t-fg` / `--t-muted` | `--vscode-foreground` / `--vscode-descriptionForeground` | text |
| `--t-border` | `--vscode-panel-border` → `widget-border` → `contrastBorder` | hairlines |
| `--t-accent` | light `#4f39f6`, dark `#7c86ff` (indigo-400), HC `--vscode-focusBorder` | accent text, borders, live indicators |
| `--t-accent-solid` | light/dark `#4f39f6`, HC `--vscode-button-background` | primary button fill |
| `--t-on-accent` | `#ffffff`, HC `--vscode-button-foreground` | text on the fill (6.6:1) |
| `--t-accent-soft` | `color-mix(in srgb, var(--t-accent) 14%, transparent)` | selected rows, active chips |
| `--t-ok` / `--t-bad` / `--t-warn` | testing/error/warning theme colours | status, always paired with an icon or word |
| `--t-add-*` / `--t-del-*` | diff editor colours | diffs only |

Theme switch uses the body classes VS Code sets: `vscode-light`, `vscode-dark`, `vscode-high-contrast`, `vscode-high-contrast-light`. In high-contrast themes the accent hands back to the theme's own colours and every bordered element uses `--vscode-contrastBorder`.

## Type

One family: `--vscode-font-family` at `--vscode-font-size` (13px). Code, paths and symbols use `--vscode-editor-font-family` at 0.92em. Scale (ratio ~1.15): 11px meta, 12px secondary, 13px body, 14px titles (600). No uppercase-tracked eyebrows; section titles are sentence case, 600 weight.

## Spacing and shape

4px grid: 4 / 8 / 12 / 16 / 24. Panel gutter 12px. Radius 4px for blocks, 6px for the composer box and popovers, 999px only for status pills. Hairline 1px borders; no shadows except popovers (`--vscode-widget-shadow`).

## Icons

`@vscode/codicons` only (the same set VS Code uses). No emoji, no unicode glyph icons (✓ ✕ ★ ▸).

## Motion

150–200 ms ease-out for expand/collapse and hover. Spinner = `codicon-loading codicon-modifier-spin`. Under `prefers-reduced-motion` everything becomes instant and the spinner becomes a static `codicon-circle-large-outline` pulse-free icon.

## Components

- **Icon button**: 22×22, transparent, `--vscode-toolbar-hoverBackground` on hover, focus ring `--vscode-focusBorder`, always has `aria-label` + `title`.
- **Button**: secondary uses VS Code secondary button vars; primary uses `--t-accent-solid` / `--t-on-accent`. Height 26px, radius 4px.
- **Chip**: 20px tall, radius 4px, `--t-surface` with hairline border, leading codicon, optional remove `×` icon button.
- **Status pill**: dot + word, never colour alone.
- **Popover / listbox**: `position: fixed`, `--vscode-quickInput-background`, 6px radius, widget shadow, full keyboard (↑↓ Enter Esc), `role="listbox"`.
- **Segmented control**: two or three icon+label buttons with `aria-pressed`.
- Every interactive element has hover, focus-visible, active and disabled states.

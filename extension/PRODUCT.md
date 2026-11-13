# Product

## Register

product

## Users
Developers working inside VS Code on a real repository. They are in the middle of focused work and want an agent that finds the right code, proposes changes and lets them review every hunk, without taking over the editor. A second audience watches the same screen in a recorded demo: competition judges, who need to understand at a glance what the agent is doing and why. The panel must work as a credible daily tool first and stay legible for that second audience. The aim is the middle ground, not a demo-only UI.

## Product Purpose
Temper is a safety-first coding agent for VS Code. Its agent loop runs on TrueForge. It shows which code it chose and why (Context Ledger), keeps every change out of the files until the user accepts it hunk by hunk, flags edits outside the requested scope or that reference symbols which don't exist, and falls back to another model automatically when one fails. Success means the user always knows what the agent is doing, what it will change, and how to undo it.

## Brand Personality
Precise, calm, trustworthy. It feels like a careful senior engineer pairing with you: it shows its reasoning, states facts plainly, and never surprises you. The voice is short and declarative, using real file and symbol names instead of hype. It sits visually close to TrueForge's console: neutral surfaces with one indigo accent.

## Anti-references
- Generic AI chat: rounded speech bubbles, avatars, sparkle emojis.
- A wall of tool logs: raw, terminal-like dumps of every tool call, given equal weight.
- Flashy "AI startup" styling: purple gradients, glassmorphism, neon glow.
- Cluttered toolbars: many buttons and badges competing at once.
- Flat, inert text: everything printed inline with nothing to expand, hover, click or jump to. Files, hunks, steps and models should be interactive.

## Design Principles
1. **Show the why.** Every choice the agent makes (files picked, edits proposed, model switched) is visible with its reason, one click from detail.
2. **Calm by default, detail on demand.** Group and collapse the noise (tool steps). Surface only the current state and the next action.
3. **The user holds the pen.** Review, accept, reject and undo are always obvious, reversible and keyboard-reachable. Nothing reaches disk unseen.
4. **Native first.** Follow the user's VS Code theme, fonts and density, so it feels built in rather than embedded.
5. **One accent, used for meaning.** Indigo marks the primary action and live activity, never decoration.

## Accessibility & Inclusion
WCAG 2.2 AA contrast in light, dark and high-contrast VS Code themes. Everything is reachable and operable by keyboard, with visible focus rings. Respect `prefers-reduced-motion`. Never encode status by colour alone; pair it with an icon or text, so colour-blind users are covered.

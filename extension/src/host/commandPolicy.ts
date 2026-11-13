// Pure helpers for run_command: allowlist matching, shell-metacharacter rejection and
// argv tokenizing. Commands are never handed to a shell, so these checks are defence in depth.

export type CommandCheck = { ok: true; argv: string[]; normalized: string } | { ok: false; reason: string };

/** Characters that would chain, redirect or substitute in a shell. */
const METACHARS = /[;&|<>`\n\r]|\$\(|\$\{/;

export function hasShellMetachars(command: string): boolean {
  return METACHARS.test(command);
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** True when `command` is exactly `prefix` or starts with `prefix` followed by a space. */
export function matchesAllowlist(command: string, allowlist: readonly string[]): boolean {
  const c = normalize(command);
  return allowlist.some((entry) => {
    const p = normalize(entry);
    return p !== '' && (c === p || c.startsWith(p + ' '));
  });
}

/** Split a command line into arguments, honouring single and double quotes (no escapes beyond `\"`). */
export function tokenize(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && command[i + 1] === '"') {
        cur += '"';
        i++;
      } else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) return undefined; // unbalanced quote
  if (has || cur) out.push(cur);
  return out;
}

export function checkCommand(command: string, allowlist: readonly string[]): CommandCheck {
  const normalized = normalize(command);
  if (!normalized) return { ok: false, reason: 'Empty command.' };
  if (hasShellMetachars(command)) {
    return {
      ok: false,
      reason:
        'Shell operators are not allowed (; & | > < ` $( newlines). Run one plain command at a time, without pipes or redirects.',
    };
  }
  if (!matchesAllowlist(command, allowlist)) {
    return {
      ok: false,
      reason: `Command not allowed. Allowed prefixes: ${allowlist.length ? allowlist.join(', ') : '(none configured)'}.`,
    };
  }
  const argv = tokenize(command);
  if (!argv || argv.length === 0) return { ok: false, reason: 'Could not parse the command (unbalanced quotes).' };
  return { ok: true, argv, normalized };
}

/** Keep the END of long output (failures are reported last). */
export function tailTruncate(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} earlier characters truncated ...]\n${text.slice(text.length - max)}`;
}

// Dependency-free display formatters shared by the extension host and the webview.

/** Token counts for humans: 8000, 12.5K, 128K, 1M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${strip(n / 1_000_000)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}K`;
  if (n >= 10_000) return `${strip(n / 1000)}K`;
  return String(n);
}

function strip(v: number): string {
  return v.toFixed(1).replace(/\.0$/, '');
}

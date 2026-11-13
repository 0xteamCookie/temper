/** Compact token counts: 640, 9.9K, 250K, 1M, 1.05M. Shared by the host and the webview. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const trim = (v: number, d: number) => String(Number(v.toFixed(d)));
  if (n >= 1_000_000) return `${trim(n / 1_000_000, n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${trim(n / 1_000, n >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

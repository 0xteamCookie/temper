// Small formatting helpers shared by the host and the webview. No dependencies.

export function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

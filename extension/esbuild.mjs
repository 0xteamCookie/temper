// Bundles the extension host code into dist/extension.js.
// The webview UI is built separately by Vite (extension/webview-ui).
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  // The TrueForge SDK ships ESM only; resolve its ESM entry points when bundling to CJS.
  mainFields: ['module', 'main'],
  conditions: ['import', 'module', 'default'],
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}

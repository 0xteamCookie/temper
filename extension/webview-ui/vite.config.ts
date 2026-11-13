import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Output goes to extension/dist/webview; the extension host loads
// assets/index.js and assets/index.css from there (see src/panel.ts).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        codeSplitting: false, // single index.js: CSP only allows the nonce'd entry script
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});

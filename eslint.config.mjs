import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.trueforge/**',
      '.impeccable/**',
      'notes/**',
      'spike/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['extension/src/**/*.ts', '*.mjs', 'extension/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['extension/webview-ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
);

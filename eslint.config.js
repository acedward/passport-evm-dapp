// ESLint flat config: JavaScript and TypeScript recommended rules, React hooks for the web app,
// and no Node built-ins in code that runs in the browser.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    'vendor/**',
    '.tools/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'packages/core/src/passport/vendor/offer-codec.ts',
    'relay/src/bridge/vendor/relayer.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.es2021 } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Code that runs in the browser: no Node built-ins.
    files: ['packages/core/src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'This code runs in the browser; Node built-ins are not available.' },
          ],
        },
      ],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: [
      'relay/**/*.ts',
      'scripts/**/*.{ts,js,mjs}',
      'test/**/*.ts',
      '**/test/**/*.{ts,tsx}',
      '*.config.{js,ts}',
      '**/*.config.{js,ts}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
]);

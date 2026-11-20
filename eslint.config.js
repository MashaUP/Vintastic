// Controllo statico (npm run lint, dentro npm test): variabili non definite, variabili inutilizzate,
// codice irraggiungibile, errori comuni. Configurazione presa da BingeMap (standard comuni, sezione 4).
import globals from 'globals';
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'tests/e2e/artifacts/**', '**/*.min.js'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
    },
  },
  // Content script classici (nessun import): caricati in ordine dal manifest, condividono globalThis.VT / VTGuard.
  { files: ['src/content/**/*.js', 'src/shared/guard-core.js'], languageOptions: { sourceType: 'script' } },
];

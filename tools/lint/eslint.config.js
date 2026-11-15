// ESLint flat config. Lives in tools/lint — its own install root, filled by the
// root `postinstall` (`npm ci --prefix tools/lint`) — so `typescript-eslint`
// resolves TypeScript 6 (it needs the TS JS API, <6.1) while the repo's own
// `tsc` stays TypeScript 7 (native, no JS API). The root eslint.config.js
// re-exports this file.
//
// Existing violations are recorded in eslint-suppressions.json (ESLint bulk
// suppressions) at the repo root. New code must be clean; burn the file down
// with `npm run lint -- --prune-suppressions` after fixing old sites.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── Config access: one reader, src/config/lab-config.ts ─────────────────────
// Replaces the regex grep that `codegen-lab-config.mjs --check` used to run.
// `no-restricted-properties` only matches a bare `location.search`, not
// `window.location.search`, so selectors cover both spellings.
const CONFIG_MSG = 'read/write it through labConfig() in src/config/lab-config.ts (docs/LAB_CONFIG.md)';
const rawConfigAccess = [
  { selector: "MemberExpression[object.name='location'][property.name=/^(search|hash)$/]", message: `Raw location.search/hash — ${CONFIG_MSG}` },
  { selector: "MemberExpression[object.property.name='location'][property.name=/^(search|hash)$/]", message: `Raw location.search/hash — ${CONFIG_MSG}` },
  { selector: "Identifier[name=/^(localStorage|sessionStorage)$/]:not(Property > Identifier.key):not(MemberExpression > Identifier.property[parent.computed=false]):not(TSPropertySignature > Identifier.key)", message: `Raw Web Storage — ${CONFIG_MSG}` },
  { selector: "MemberExpression[property.name=/^(localStorage|sessionStorage)$/][object.name=/^(window|globalThis|self)$/]", message: `Raw Web Storage — ${CONFIG_MSG}` },
  { selector: "NewExpression[callee.name='URLSearchParams']", message: `new URLSearchParams( — ${CONFIG_MSG}` }
];

// ── CLAUDE.md "Do not": wgsl-include.js is Node/CI only ────────────────────
const noWgslInclude = {
  patterns: [{
    group: ['**/wgsl-include.js', '**/wgsl-include'],
    message: 'wgsl-include.js is Node/CI only; Vite expands `#include` in browser code (CLAUDE.md "Do not").'
  }]
};

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'tools/**/node_modules/**', '.claude/**', '.cache/**',
      'src/public/**', 'src/wasm/**', 'generated/**',
      'cpp/**', 'firmware/**', 'physics/**', 'colab/**', 'tests/**', 'e2e/**',
      '**/*.d.ts'
    ]
  },

  // Every browser source file (TS and the JS that stays JS).
  {
    files: ['src/**/*.{ts,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': ['error', noWgslInclude]
    }
  },
  {
    files: ['src/**/*.{ts,js,mjs}'],
    ignores: ['src/config/**'],
    rules: { 'no-restricted-syntax': ['error', ...rawConfigAccess] }
  },
  // The Vite plugin that expands #include runs in Node, not the browser.
  {
    files: ['src/shaders/vite-plugin-wgsl-include.js', 'src/shaders/wgsl-include.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-imports': 'off' }
  },

  // Typed linting: TS sources only.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: ROOT
      }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // WebGPU init, adapters, buffer maps and the WASM loader are all async:
      // an unawaited promise there is a silent boot failure.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // verbatimModuleSyntax already requires `import type`; this keeps it fixable.
      // `typeof import('./lazy.js')` stays legal: it types a lazy chunk without
      // pulling it into the entry closure (check:entry-chunk).
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }]
    }
  },

  // Node tooling: scripts/, configs. Untyped, correctness rules only.
  {
    files: ['scripts/**/*.{js,mjs}', '*.{js,mjs}', 'tools/lint/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  }
);

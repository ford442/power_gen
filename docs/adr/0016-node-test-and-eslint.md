# ADR-0016: `node:test` as the one test runner; ESLint in its own TS 6 toolchain

- **Status:** Accepted
- **Date:** 2026-11

## Context

`npm run validate` was one `&&` chain of 39 steps: serial, stopped at the first
failure, no summary. The unit tests were 28 hand-rolled `scripts/test-*.mjs`,
each repeating esbuild + temp-dir + `import(data:…)` boilerplate and printing
its own `ok:` lines. #222 asked for Vitest and ESLint and closed with neither.
The feature issues that follow (#254–#257) add numerics that need real unit
tests, and the three lint-like rules lived in bespoke scripts.

## Decision

**Test runner: `node:test`.** No new dependency — Node 22 ships `describe` /
`it`, `--test-concurrency`, a spec/TAP reporter and `--experimental-test-coverage`.
Vitest was the alternative the issue allowed *if measured faster on CI*; it was
not adopted, because:

- the expensive part of these suites is the work under test (RK4 plants, the
  native/WASM goldens, the live-lab runner), not the runner, so a faster
  runner has little to win;
- the tests already import TS through esbuild, which Vite uses too; Vitest
  would add a second transform path and ~30 transitive packages for parity
  with what `node --test` does already;
- one runner, not two — and the issue says not to run both.

If a later suite needs Vitest-only features (browser mode, snapshot files),
measure it on the SwiftShader CI runner against `node --test` and supersede
this ADR.

- `scripts/test-harness.mjs` is the only place a test turns TS into a module:
  `bundleTs('src/….ts' | { contents })`. Bundles are cached by the sha-256 of
  every input file in `node_modules/.cache/seg-tests` (in `.cache/` under
  coverage, which ignores `node_modules`), carry inline source maps, and are
  imported by file URL.
- Tests are `scripts/tests/<alias>.test.mjs`; `test:<alias>` keeps working.
  The by-hand firmware test is `scripts/tests/manual/` so the glob skips it.
- `test:coverage` reports only (no gate yet).

**`validate` is `scripts/validate.mjs`:** codegen (serial, it writes files),
then every read-only check (typecheck, lint, drift checks, file size, post /
WGSL / bindings contracts) and `wasm:native` in parallel, then `node --test`
over every suite once the native build is done (+ `check:entry-chunk`). Steps
declare what they need instead of waiting on a whole stage, so the native
build and the tests overlap lint, the slowest check. Every step runs; the
table at the end has pass/fail and seconds per step. `validate.yml` still just
calls `npm run validate`.

Measured on a 4-core container (no naga, so `check:wgsl` skips in both):

| | wall-clock |
|---|---|
| old `&&` chain (no lint, no checkJs) | 20.6 s |
| `validate.mjs`, warm test-bundle cache (lint + checkJs included) | 13.8 s |
| `validate.mjs`, cold cache (CI) | 14.0 s |

Lint is ~10–13 s of that by itself, and it is the critical path.

**ESLint: flat config, typed typescript-eslint, in `tools/lint/`.** The repo's
`tsc` is TypeScript 7 (native Go, no JS API). typescript-eslint needs the TS
JS API and supports `<6.1`, so `tools/lint/` is its own install root pinning
TypeScript 6 — not an npm workspace, which hoists `ts-api-utils` next to the
root TS 7 and breaks. The root `postinstall` runs `npm ci --prefix tools/lint`;
the root `eslint.config.js` re-exports `tools/lint/eslint.config.js`.

- The raw `location.search` / `location.hash` / Web Storage /
  `new URLSearchParams(` grep in `codegen-lab-config --check` is now a
  `no-restricted-syntax` rule (selectors, because `no-restricted-properties`
  misses `window.location.search`); `src/config/` is exempt.
- `no-restricted-imports` bans `wgsl-include.js` from browser code.
- Typed starter rules: `no-floating-promises`, `no-misused-promises`,
  `consistent-type-imports` (`typeof import('…')` stays legal — it types lazy
  chunks without pulling them into the entry closure), plus `eqeqeq`.
- Existing violations are in `eslint-suppressions.json` (ESLint bulk
  suppressions); new code must be clean. Burn it down and run
  `npm run lint -- --prune-suppressions`.

**Checked JS.** `tsconfig.js.json` runs `checkJs` on `src/renderers/webgl2/**`
and `src/seg-geometry/**` (they stay JS per AGENTS.md) with `noImplicitAny`
off — checked, not fully annotated; everything else under `strict` is on.
`typecheck` runs both configs.

## Consequences

- One failing step no longer hides the rest; CI logs fold each step.
- Adding a test is a file in `scripts/tests/`; no npm script needed.
- When typescript-eslint supports the TS 7 API, delete the TS 6 pin and fold
  `tools/lint` back into the root `devDependencies`.
- The prototype-mixin sites are gone, so `check:mixin-shadowing` is deleted;
  ESLint could not have seen across `Object.assign(…prototype)` anyway.

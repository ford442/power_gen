# ADR-0020: WebGPU under test — Dawn in Node, headed SwiftShader e2e, one toolchain pin file

- **Status:** Accepted
- **Date:** 2026-11
- **Issue:** #258

## Context

The primary renderer had no automated runtime coverage. `validate.yml` ran one
browser job and every spec in it booted `?renderer=webgl2`; `check:wgsl`
proves each module *parses* in naga and creates no pipeline. So a
shader / layout mismatch, a wrong vertex stride, or a pipeline handle that is
silently `null` reached Pages, and was found by hand in a headed browser: the
class-field-shadows-mixin boot break, the consumed-adapter device loss (#221),
the two always-`null` pipelines in #252. The compute passes had CPU twins and
no comparison; `test:fdtd` and `test:field-volume` *translate* WGSL to JS to
execute it, which checks the text, not what a GPU does with it.

Tool versions had also drifted: CI installed a naga from early 2024 while dev
boxes ran one two years newer, and the naga pin was written in three places.

## Decision

**1. Dawn in Node (`webgpu` npm package) as a test-only dependency.**
`scripts/lib/node-gpu.mjs` opens Dawn once per test process and prefers the
software adapter (Lavapipe / SwiftShader) wherever one exists, so a laptop
with a real GPU and a CI runner execute the same rasteriser. No adapter is a
*skip with a notice*; `REQUIRE_GPU=1` (CI) makes it a failure — the contract
`check:wgsl` and `wasm:native:san` already use. `validate` prints skip notices
even for green steps, because a gate that skips quietly is how coverage
disappears.

It never enters the browser bundle: ESLint's `no-restricted-imports` bans
`webgpu`, `pixelmatch` and `pngjs` under `src/`.

Dawn is Chrome's implementation — Tint for WGSL, Dawn for validation — so
what compiles there is what compiles in the browser users actually have. It
is not the *same build* as the Chromium Playwright ships, and it is not a
canvas: nothing that needs presentation, the DOM or the frame loop runs
there. That is what the browser job is for.

**2. Tests drive the app's own objects, not a re-description of them.**
`test:pipelines` constructs the real `PipelineLayoutCache` on a Dawn device
requested the way `webgpu-manager.ts` requests it, and calls every `ensure*`
factory with the real shader text (the test harness's `wgslRaw` plugin runs
the same `#include` resolver as the Vite plugin) for each colour mode × depth
format × sample count. `test:gpu-golden` runs each compute pass through its
real host class where one exists (`WebgpuReduce`, `OverviewCullPass`,
`IblPrefilterCompute`) and compares a readback with the CPU twin. A test that
re-declared layouts or re-packed uniforms would pass while the app broke.

**3. naga stays, as the portable gate.** `check:wgsl` is fast, needs no GPU
and is the stand-in for Firefox / wgpu; Tint and naga disagree in both
directions (docs/SHADERS.md). The pin moves to the current release and there
is no allowlist.

**4. A headed-browser job for what only a browser shows.**
`playwright.webgpu.config.js`: headed Chromium under `xvfb-run` with
SwiftShader's Vulkan (headless Chromium gets no WebGPU adapter on a GPU-less
runner), against `vite preview` of a fresh build. The page exposes
`window.__gpuErrors` (every `uncapturederror`, scoped error and device loss,
counted) so specs assert on a number, not on console text. A test-side probe
records which pipelines actually drew: a `null` pipeline raises no error, its
draw is just skipped, so "the transformer drew its flux ribbons" has to be
observed.

**5. Image baselines start report-only.** Six frozen views per renderer,
`pixelmatch` against PNGs committed under `e2e/baselines/`. Report-only until
they have been stable on CI for two weeks (`BASELINE_GATE=1` is the switch),
because a gate that flakes gets disabled, and a disabled gate is worse than a
report people read. The same views on WebGL2 give a measured parity number.

**6. One pin file.** `config/toolchain.json` holds emsdk, naga, node and
playwright. Workflows and scripts read it through `scripts/toolchain.mjs`;
`check:toolchain` fails on a version written anywhere else. Two mirrors exist
because a tool dictates the location (`.nvmrc`; `@playwright/test` in
`package.json`) and are verified against the pin. The emsdk pin stays an
input of `sim_core_source_hash()`, hashed under the path it had as
`cpp/emsdk-version`, so moving it did not stale the committed binary and a
future emsdk bump still flags a binary built with the old compiler.

## Consequences

- `npm run validate` gains `test:pipelines`, `test:gpu-golden`,
  `check:toolchain` and `check:bundle-budget`; CI installs
  `mesa-vulkan-drivers` (Lavapipe) and sets `REQUIRE_GPU=1`.
- A new CI job, `webgpu-e2e`, about ten minutes on a hosted runner. It is the
  slowest job; the specs are kept few on purpose.
- Tolerances in the goldens are set on a software rasteriser and say so. A
  real GPU may fuse multiply-adds differently; nothing here claims driver
  coverage. Real-GPU runners, performance baselines and Safari / Firefox e2e
  are out of scope.
- The `webgpu` package ships prebuilt Dawn for every platform (≈130 MB
  unpacked). It is a devDependency; `npm ci --omit=dev` and the site build do
  not need it.
- `scripts/lib/wgsl-mini.mjs` and `wgsl-fdtd-eval.mjs` (WGSL executed on the
  CPU) stay: they run without any adapter, so `test:fdtd` and
  `test:field-volume` never skip. The Dawn goldens are the stronger check
  when a GPU is there.
- The naga pin moved from the early-2024 release (0.19) to the current one.
  Moving emsdk off its mid-2024 release is a separate change with its own
  gates (bit-identical snapshots, size, ABI) — the pin file makes it a
  one-line diff plus a rebuild.

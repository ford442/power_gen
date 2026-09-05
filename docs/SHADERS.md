# Shaders guide

How WGSL is authored, included, validated, and extended in the SEG WebGPU visualizer.

## Layout

```
src/shaders/
  common/                 # Shared structs & PBR fragments (#include targets)
    particle.wgsl         # GpuParticle (16 B) + SimParticle (32 B, C++)
    pipe-particle.wgsl    # PipeParticle / PipeCurve (energy pipes)
    bloom-params.wgsl     # BloomParams (post stack — check:post contract)
    frame-uniforms.wgsl   # viewProj / time / cameraPos
    device-uniforms.wgsl  # 48 B device pack
    compute-uniforms.wgsl # particle compute uniforms (incl. GPU LOD level)
    overview-lod.wgsl     # overview particle LOD ladder (shared by 2 passes)
    overview-cull.wgsl    # device bounds / draw-indirect args / frustum test
    pbr-*.wgsl            # surface / BRDF / lighting / eval
  passes/                 # Full entry-point modules (canonical runtime WGSL)
    particle-compute.wgsl
    bloom-*.wgsl          # vert / extract / blur / composite
    roller-*.wgsl, seg-enhanced-*.wgsl, …
    ssr-compute.wgsl      # screen-space reflections
  generators/             # Thin ?raw re-exports for MultiDeviceShaders
  archive/                # Legacy / experimental WGSL (excluded from naga)
  wgsl-include.js         # Node preprocessor (#include)
  vite-plugin-wgsl-include.js
```

**Runtime source of truth:** `passes/*` + `common/*`. Generators only re-export
`?raw` strings; **do not** add new `/* wgsl */` template literals in JS.

## Particle layout (single contract)

| Path | Struct | Size | Where |
|------|--------|------|--------|
| Interactive WebGPU | `GpuParticle` `{ pos: vec3f, phase: f32 }` | **16 B** | `DeviceGeometry`, compute + billboards |
| C++ / WASM | `SimParticle` (x,y,z,phase,vx,vy,vz,aux) | **32 B** | `cpp/src/sim_core.h` |

Both are defined in `common/particle.wgsl`. JS constant:
`PARTICLE_BYTES_PER_INSTANCE = 16` in `device-geometry.ts` (asserted in
`device-pipeline-manager.ts`).

When changing particle fields:

1. Update `common/particle.wgsl`
2. Update C++ `SimParticle` if the high-precision path is affected
3. Update reseeding in `device-geometry.ts` / WASM seed
4. Run `npm run check:wgsl`

## `#include` preprocessor

Syntax (line-oriented, paths relative to `src/shaders/`):

```wgsl
#include "common/particle.wgsl"
#include "common/compute-uniforms.wgsl"
```

- **Vite:** `vite-plugin-wgsl-include` expands includes for `*.wgsl` and `?raw`
  imports before the browser sees them.
- **Node / CI:** `loadWgslFile()` / `resolveWgsl()` in `wgsl-include.js`.
- Nested includes are allowed; cycles throw.
- Include fragments without `@vertex` / `@fragment` / `@compute` are not
  validated alone (they have no entry points).

### Browser vs Node

Do **not** import `wgsl-include.js` from code that ships to the browser — it
uses `node:fs`. Use `?raw` imports and let the Vite plugin expand includes.

## Adding a new shader pass

1. **Shared types** — put reusable structs in `common/*.wgsl` (or extend an
   existing file). Document host buffer layout in a comment.
2. **Pass file** — add `passes/my-pass.wgsl` with `#include`s and entry points:
   ```wgsl
   #include "common/frame-uniforms.wgsl"

   @vertex
   fn vs_main(/* … */) -> /* … */ { /* … */ }

   @fragment
   fn fs_main(/* … */) -> @location(0) vec4f { /* … */ }
   ```
3. **Bind group** — register layout in `src/pipeline-layout/layouts/*.ts` and
   document in `docs/BINDINGS.md`.
4. **Wire runtime** — thin `?raw` re-export in a generator (or direct import in
   `multi-device-shaders.js`).
5. **Validate** — `npm run check:wgsl`; add a `check:post` case if CPU packs a
   matching struct.
6. **Optional WebGL2** — mirror in `renderers/webgl2/` only if required
   (`docs/WEBGL2.md`).

**Rule:** no new `/* wgsl */` strings in JS on the WebGPU path.

## CI validation

```bash
npm run check:wgsl          # local: skip if naga missing
npm run check:post          # CPU↔WGSL post contracts
REQUIRE_NAGA=1 npm run check:wgsl   # CI (validate.yml)
```

`npm run validate` runs both checks (among others).

Flow:

1. `node scripts/extract-wgsl.mjs` → `build/wgsl-check/*.wgsl`
2. `naga` each module with an entry point
3. Unexpected failures fail the job; allowlisted Tint-only debt is warned

Allowlist: `KNOWN_NAGA_FAILURES` in `scripts/check-wgsl.sh`. Prefer fixing
shaders over growing the list.

### CPU ↔ WGSL contracts

```bash
npm run check:post          # scripts/check-post-contracts.mjs
```

naga validates each module in isolation, so it cannot see a uniform packed as
N floats on the CPU and read as M fields in WGSL — both sides stay individually
valid while the frame silently corrupts. `check:post` closes that gap for the
post stack:

- `BloomParams` in `common/bloom-params.wgsl` has the same field count
  `packPostUniforms()` emits, and `bloomParamsBuffer` is sized for it
- `SsrParams` in `ssr-compute.wgsl` matches `SSR_PARAMS_BYTES` and is 16-byte
  aligned
- `IBL_TEX_SIZE` / `IBL_SPEC_LEVELS` agree between `ibl-prefilter.ts` and
  `pbr-eval.wgsl`

Add a case here whenever you introduce a new struct that is written on the CPU
and declared in WGSL.

## Particle mode indices

`passes/particle-compute.wgsl` compares `u32(uniforms.mode + 0.5)` to named
constants from `#include "generated/device-catalog.wgsl"` (`MODE_HOMOPOLAR`,
…). Numbers come from `physics/devices.json` `shaderMode` (not C++ `SimMode`).
See [`MODE_MATRIX.md`](MODE_MATRIX.md). Physics uniforms `physics0..3` carry
per-mode scalars.

## naga vs Chrome (Tint) differences

naga (used offline) is **stricter** than Tint in several places. Patterns that
pass in Chrome but fail naga:

| Issue | Tint | naga | Workaround |
|-------|------|------|------------|
| Dynamic index of a `let`/`const` value array: `array<f32,3>(a,b,c)[i]` | OK | Error | Use `if` / `select` / storage buffer |
| Reserved identifiers (`active`, etc.) | Sometimes OK | Error | Rename (e.g. `is_active`) |
| Incomplete include fragments (no entry) | n/a | Skip | Only check modules with `@vertex`/`@fragment`/`@compute` |
| Multi-file LED/solar | `#include` in compute/render | Full expand via `wgsl-include` | `led-solar-compute.wgsl` / `led-solar-render.wgsl` include constants/structs/physics |

When you hit a naga-only failure that Chrome accepts:

1. Prefer a portable rewrite (see field-advect `ringRadius()`).
2. If blocked, add a **short** allowlist entry with a comment and track removal.
3. Document the case here.

Install naga locally:

```bash
cargo install naga-cli --version 0.19.0 --locked
```

## PBR chunks

`common/pbr-*.wgsl` are the source files. Pass files `#include` them directly:

```wgsl
#include "common/pbr-surface.wgsl"
#include "common/pbr-brdf.wgsl"
#include "common/pbr-lighting.wgsl"
#include "common/pbr-eval.wgsl"
```

`generators/pbr-wgsl-chunks.js` remains a thin `?raw` re-export for any legacy
call sites.

## Archive

Stale duplicates (`compute.wgsl`, `particles.wgsl`, `lightning.wgsl`, …) and
the experimental LED/solar suite live under `src/shaders/archive/`. That tree
is **excluded** from `npm run check:wgsl` unless explicitly opted in.

## Post stack (WebGPU bloom / filmic)

Runtime source: `passes/bloom-*.wgsl` (via thin `generators/bloom-shaders.js` →
`multi-device-shaders.js` → `pipeline-layout-cache`).

| Pass | Entry | Notes |
|------|-------|-------|
| Extract | `getBloomExtractShader` | Corona-weighted threshold + knee |
| Blur | `getBloomBlurShader` | Separable 5-tap; radius from preset |
| Composite | `getBloomCompositeShader` | AO, contact shadow, bloom add, **exposure**, **filmic tonemap**, grain, vignette |

**Quality gates**

1. Prefer negotiated HDR intermediate formats when the adapter supports them
   (`WebGPUManager.bloomIntermediateFormat`).
2. Uniform layout (`BloomParams`, 16 floats) must stay in lockstep with
   `packPostUniforms()` in `seg-lighting-presets.ts`.
3. Auto-quality tiers scale post cost via `getPostQualityGates()` in
   `post-processing-config.ts` (critical skips bloom extract/blur; disables SSAO + motion blur).
4. Run `npm run check:wgsl` and `npm run check:post` after editing bloom passes.
5. WebGL2 does **not** run this stack — document gaps in `WEBGL2.md`.

IBL: `approximateIBL` / `envRadiance` in `common/pbr-eval.wgsl` — analytic 3-mip
studio env (no PMREM). Full look/preset docs: [`LIGHTING_RIG.md`](./LIGHTING_RIG.md). Epic: ADR-0005.

## Related docs

- `docs/BINDINGS.md` — bind group numbers
- `docs/WEBGPU.md` — adapter / device notes
- `docs/WEBGL2.md` — intentional WebGL2 gaps
- `docs/LIGHTING_RIG.md` — lighting looks + post quality gates
- `cpp/README.md` — WASM particle export (`SimParticle`)

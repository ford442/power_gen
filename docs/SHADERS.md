# Shaders guide

How WGSL is authored, included, validated, and extended in the SEG WebGPU visualizer.

## Layout

```
src/shaders/
  common/                 # Shared structs & PBR fragments (#include targets)
    particle.wgsl         # GpuParticle (16 B) + SimParticle (32 B, C++)
    frame-uniforms.wgsl   # viewProj / time / cameraPos
    device-uniforms.wgsl  # 48 B device pack
    compute-uniforms.wgsl # particle compute uniforms
    pbr-*.wgsl            # surface / BRDF / lighting / eval
  passes/                 # Full entry-point modules (preferred for new work)
    particle-compute.wgsl
  generators/             # JS factories used by MultiDeviceShaders
  *.wgsl                  # Legacy / specialized modules (flux, bloom, led-solar, …)
  wgsl-include.js         # Node preprocessor (#include)
  vite-plugin-wgsl-include.js
```

**Runtime source of truth for multi-device:** `generators/*` + `passes/*` via
`multi-device-shaders.js`. Prefer editing `passes/` and `common/` for anything
shared; keep generators thin (import `?raw` or concatenate chunks).

## Particle layout (single contract)

| Path | Struct | Size | Where |
|------|--------|------|--------|
| Interactive WebGPU | `GpuParticle` `{ pos: vec3f, phase: f32 }` | **16 B** | `DeviceGeometry`, compute + billboards |
| C++ / WASM | `SimParticle` (x,y,z,phase,vx,vy,vz,aux) | **32 B** | `cpp/src/sim_core.h` |

Both are defined in `common/particle.wgsl`. JS constant:
`PARTICLE_BYTES_PER_INSTANCE = 16` in `device-geometry.js` (asserted in
`device-pipeline-manager.js`).

When changing particle fields:

1. Update `common/particle.wgsl`
2. Update C++ `SimParticle` if the high-precision path is affected
3. Update reseeding in `device-geometry.js` / WASM seed
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
3. **Bind group** — register layout in `pipeline-layout-cache.js` and document
   in `docs/BINDINGS.md`.
4. **Wire runtime** — either:
   - `import code from '../passes/my-pass.wgsl?raw'` in a generator, or
   - add getters on `MultiDeviceShaders`.
5. **Validate** — `npm run check:wgsl` (requires naga for hard fail in CI).
6. **Optional WebGL2** — mirror in `renderers/webgl2/` only if the feature is
   required on the fallback path (`docs/WEBGL2.md`).

### Generator-only passes (legacy style)

```js
import frame from '../common/frame-uniforms.wgsl?raw';

export function getMyVertShader() {
  return /* wgsl */ `
${frame}
@vertex fn main() -> @builtin(position) vec4f {
  return vec4f(0.0);
}
`;
}
```

`scripts/extract-wgsl.mjs` pulls these templates for naga when they contain
entry-point attributes.

## CI validation

```bash
npm run check:wgsl          # local: skip if naga missing
REQUIRE_NAGA=1 npm run check:wgsl   # CI (validate.yml)
```

Flow:

1. `node scripts/extract-wgsl.mjs` → `build/wgsl-check/*.wgsl`
2. `naga` each module with an entry point
3. Unexpected failures fail the job; allowlisted Tint-only debt is warned

Allowlist: `KNOWN_NAGA_FAILURES` in `scripts/check-wgsl.sh`. Prefer fixing
shaders over growing the list.

## naga vs Chrome (Tint) differences

naga (used offline) is **stricter** than Tint in several places. Patterns that
pass in Chrome but fail naga:

| Issue | Tint | naga | Workaround |
|-------|------|------|------------|
| Dynamic index of a `let`/`const` value array: `array<f32,3>(a,b,c)[i]` | OK | Error | Use `if` / `select` / storage buffer |
| Reserved identifiers (`active`, etc.) | Sometimes OK | Error | Rename (e.g. `is_active`) |
| Incomplete include fragments (no entry) | n/a | Skip | Only check modules with `@vertex`/`@fragment`/`@compute` |
| Multi-file LED/solar concat | Runtime join | Needs full expand | `led-solar.js` joins; compute/render still allowlisted until cleaned |

When you hit a naga-only failure that Chrome accepts:

1. Prefer a portable rewrite (see field-advect `ringRadius()`).
2. If blocked, add a **short** allowlist entry with a comment and track removal.
3. Document the case here.

Install naga locally:

```bash
cargo install naga-cli --version 0.19.0 --locked
```

## PBR chunks

`common/pbr-*.wgsl` are the source files. `generators/pbr-wgsl-chunks.js`
re-exports them via `?raw` for string concatenation in roller / seg-enhanced
shaders. Passes may also:

```wgsl
#include "common/pbr-surface.wgsl"
#include "common/pbr-brdf.wgsl"
#include "common/pbr-lighting.wgsl"
#include "common/pbr-eval.wgsl"
```

## Legacy root `.wgsl` files

Some top-level files (`compute.wgsl`, `particles.wgsl`, `lightning.wgsl`) are
**stale duplicates** of flux-related content and are **not** the multi-device
particle path. Prefer `passes/particle-compute.wgsl` and generators. Flux lines
live in `flux-lines.wgsl` and `generators/field-line-shaders.js`.

## Related docs

- `docs/BINDINGS.md` — bind group numbers
- `docs/WEBGPU.md` — adapter / device notes
- `docs/WEBGL2.md` — intentional WebGL2 gaps
- `cpp/README.md` — WASM particle export (`SimParticle`)

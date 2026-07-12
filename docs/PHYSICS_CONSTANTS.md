# Physics constants — single source of truth

Numeric physics constants shared across TypeScript, C++, and WGSL are authored once in
[`physics/constants.json`](../physics/constants.json) and emitted by codegen.

## Regenerate

```bash
npm run codegen:constants   # write generated/*
npm run check:constants     # CI: fail if outputs are stale
```

Outputs:

| File | Consumer |
|------|----------|
| `generated/physics-constants.ts` | TS modules (`ValidatedConstants.ts`, `scientific-data.js`, …) |
| `generated/physics-constants.js` | JS imports (Vite resolves from repo root) |
| `generated/constants.h` | `cpp/src/sim_core.h` (`PhysicsConstants`, `ParticleLayouts`, `WasmSegDefaults`) |
| `generated/constants.wgsl` | Reference copy |
| `src/shaders/generated/constants.wgsl` | `#include "generated/constants.wgsl"` in WGSL |

**Do not hand-edit generated files.** Change `physics/constants.json` and rerun codegen.

## What belongs in JSON vs elsewhere

| In `constants.json` | Elsewhere (intentionally) |
|---------------------|---------------------------|
| CODATA μ₀, ε₀, G, k_B, e, c, π | Layout ring counts / radii presets → `src/seg-layout.js` `PRESET_DEFS` |
| SEG NdFeB Br, μ_r, reference roller geometry | Per-preset world scale, flux-line counts → `seg-layout.js` + `SEGLayoutUniforms` |
| Kelvin / Heron / LED–solar core efficiencies | LED spectral wavelengths, IV curve UI metadata → `led-solar-constants.ts` |
| Particle byte strides (16 / 32 B) | WGSL struct definitions → `src/shaders/common/*.wgsl` |

WASM `SEGSimulator` default ring topology (12/22/32 at scene radii 3.5/5.5/7.5) lives in
`wasmSegDefaults` — separate from visual presets (e.g. Searl 10/25/35).

## Particle layouts

| Struct | Bytes | Floats | Where |
|--------|-------|--------|-------|
| **GpuParticle** | 16 | 4 (vec3f + phase) | WebGPU instance buffers, `device-geometry.js` |
| **SimParticle** | 32 | 8 | WASM `sim_core`, `common/particle.wgsl` |
| **PipeParticle** | 32 | 8 | Energy pipes, `common/pipe-particle.wgsl` |
| **FieldParticle** | 32 | 8 | Field-line advection, `common/field-particle.wgsl` |

C++ `static_assert` and TS `assertParticleLayouts()` guard the 16/32-byte contract.
Call `assertParticleLayouts()` once during bootstrap if you want a runtime check.

## Scene-unit scaling

The visualizer uses **scene units**, not 1:1 metres on screen:

1. **Layout presets** (`seg-layout.js`): each preset has `worldScale` (e.g. Searl = 2, Roschin = 4).
   Real-metre reference dimensions from `segRollerComposite` in JSON are multiplied by preset scale.
2. **WASM gravity**: `sim_core.cpp` applies fractional `G` (e.g. `G * 0.35`) for stable scene motion.
3. **μ₀ and Br** are always SI/CODATA — field magnitudes are physically consistent; distances are scene-scaled.

See `SCENE_SCALING` in generated TS for documented preset examples.

## Changing Br (acceptance check)

1. Edit `physics/constants.json` → `segMagnet.Br`
2. `npm run codegen:constants`
3. Verify: TS (`SEG_MAGNET.Br`), C++ (`PhysicsConstants::Br_DEFAULT`), WGSL (`SEG_BR`) all update.
4. `npm run validate`

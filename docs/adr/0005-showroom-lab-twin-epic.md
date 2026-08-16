# ADR-0005: Showroom / Lab / Twin epic (north star)

- **Status:** Accepted — Workstream 3 (hardware twin maturation) complete; Workstream 2 post stack ongoing
- **Date:** 2026-07
- **Supersedes (spirit):** closed #94 phased CAD plan; complements ADR-0003

## Context

The product can become a **browser-native electromagnetics museum + operator digital twin**:

| Mode | Intent |
|------|--------|
| **Showroom** | Production-looking SEG assembly (CAD housing, coils, stands); path-traced *look* via custom post (not offline PT); lighting presets `studio` / `lab` / `drama` |
| **Lab** | Today’s scientific dashboard, explainer tour, energy network, multi-device overview |
| **Twin** | Web Serial + optional firmware drive real coils; shadow-compare sim vs sensors |

ADR-0003 forbids Three.js. CAD content must feed the existing WebGPU/WebGL2 mesh path through a **thin glTF loader** (already hand-rolled under `src/assets/gltf/`).

Foundation issues (WASM flags, TS Wave 2, device strategies, LED-solar naga, Energy Phase B) land first; this epic is the **graphics/content north star** once the plant stays maintainable.

## Decision

1. Keep a **formal scene graph** (`SceneNode`: transform, mesh, material, anchors) owned by this repo — no engine dependency.
2. Load **static CAD** via glTF/GLB; keep rollers procedural/instanced.
3. Grow a **WebGPU-first cinematic post stack** (bloom → filmic tonemap + preset exposure → cheap AO / contact shadow → IBL for metals), quality-gated by the profiler.
4. Mature the **hardware twin** without blocking web-only users: mock transport for CI/demos; real Serial optional; firmware stays experimental.
5. Target **8–12 devices** via LOD / particle budgets / overview culling (continue closed #90 spirit).

### Explicit non-goals

- Server backend / accounts
- Claiming free-energy metrology
- Full Maxwell FEM in-browser (WASM remains lumped ODEs)

## Epic checklist

### Workstream 1 — Scene graph + glTF pipeline

- [x] Formal `SceneNode` type (`src/assets/scene/scene-node.js`)
- [x] Housing shell glTF (closed #102)
- [x] Second CAD prop: coil former GLB in SEG focus
- [x] Node hierarchy polish (lazy multi-prop registry, material overrides)
- [x] Optional minimal external glTF parser eval (parser only — not a full engine) — **deferred**: hand-rolled loader wins on gzip; see `docs/GLTF_ASSETS.md`
- [x] WebGL2: skip heavy glTF or load reduced LODs — documented in `docs/WEBGL2.md`
- [x] Instancing policy documented (procedural rollers vs static CAD) — `docs/GLTF_ASSETS.md`

### Workstream 2 — Cinematic post stack (WebGPU-first)

- [x] Bloom extract / blur / composite
- [x] Filmic curve + exposure from lighting preset
- [x] Cheap SSAO + contact shadow (composite)
- [x] IBL irradiance polish for SEG metals (analytic env mips in `pbr-eval.wgsl`)
- [x] Wire post cost into auto-quality tiers (`post-processing-config.js` + render loop)
- [x] Document stack + quality gates (`docs/SHADERS.md`, `docs/LIGHTING_RIG.md`)
- [ ] Negotiate optional features only when present (`rg11b10ufloat-renderable`, etc.)

### Workstream 3 — Hardware twin maturation

- [x] Protocol + mock transport (`docs/hardware_connection.md`)
- [x] Shadow residual on TelemetryHub + mock e2e
- [x] Closed-loop: sensor RPM → roller viz (sanitized; NaN-safe)
- [x] Open-loop: sim → coil PWM (duty 0–1 clamp; disconnect coasts)
- [x] Shadow residual charts on scientific UI (`ShadowResidualGauge`)
- [x] Connection state badge (`disconnected` | `mock` | `serial`)
- [x] Keep firmware optional — never block web-only users
- [ ] Research only: WebUSB / Bluetooth if Serial is insufficient

### Workstream 4 — Performance headroom (8–12 devices)

- [x] Continue LOD / particle budgets (`particle-budgets.js`, mesh LOD ladder, pipe tiers)
- [x] Overview culling (frustum for 20 m plugin ring + CPU instance prefix)
- [x] GPU compute cull → draw-indirect (`passes/overview-cull-compute.wgsl`,
      `devices/overview-cull.js`, layout `overviewCull`). One thread per device
      slot writes the particle draw args at a stable byte offset; the CPU never
      reads the result back. Culled/disabled devices get `instanceCount = 0`.
- [x] GPU particle LOD: per-device `lodLevel` 0–3 in `ComputeUniforms`; the
      particle compute pass keeps `particleCount >> lodLevel` and the cull pass
      sizes the indirect draw with the same ladder
      (`shaders/common/overview-lod.wgsl` ↔ `overviewLodParticleCount`). This
      replaces the per-frame `resolveScaledParticleCount` ladder in overview
      with one distance compare per device.
- [x] Shared pipeline cache (already)
- [x] Profiler: per-device CPU ms + draw-call estimate + adapter summary (F3)
- [x] Profiler: `drawPrepMs` (CPU draw-prep scope) + `overviewCullActive`, so
      the GPU path can be compared against the CPU-prefix baseline in F3

**GPU cull fallbacks (CPU instance prefix still applies):** focus views,
explainer tours that cap particles (`explainerScale < 1`), and any frame where
the cull pipeline failed to build. Both paths keep `scaledParticleCount` as the
live count, so diagnostics and effect budgets are unchanged.

**Measuring WS4 acceptance:** `window.captureOverviewCull()` reads back the
pass's visible count, per-device LOD level, and the actual `instanceCount` the
GPU wrote, alongside `drawPrepMs`. F3 shows `Draw prep (CPU)` with a `GPU cull`
marker while the path is active.

### Acceptance (epic-level)

- [x] Written ADR / checklist (this file) + Future pointer in `docs/AGENTS.md`
- [x] At least one CAD prop beyond housing shell in the live demo
- [x] Post stack documented with quality gates
- [x] Hardware twin: documented happy path mock + real Serial caveats
- [x] No Three.js; bundle size budget in PR template

## First PR slice (this change set)

1. Formal `SceneNode` + load coil-former glTF into SEG focus
2. Filmic tonemap polish + exposure from lighting preset
3. Hardware twin: publish `shadowResidual` on TelemetryHub; e2e with `?mockHardware=1`

## Consequences

- **Positive:** Clear north star without pulling in an engine; CAD and post can evolve incrementally; twin stays optional.
- **Negative:** Authoring/LOD tooling remains in-house; showroom fidelity depends on artist GLBs and post polish, not path tracing.
- **Neutral:** WebGL2 remains intentionally reduced (no heavy glTF / bloom) — see `docs/WEBGL2.md`.

## Related

- ADR-0001, ADR-0003, ADR-0004
- `docs/GLTF_ASSETS.md`, `docs/LIGHTING_RIG.md`, `docs/hardware_connection.md`
- Closed #83, #86, #89, #94, #102

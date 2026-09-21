# ADR-0005: Showroom / Lab / Twin epic (north star)

- **Status:** Accepted — Workstream 3 (hardware twin maturation) complete incl. wireless transports; Workstream 2 post stack ongoing
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
5. Target **14+ classroom benches, LOD-limited**, via LOD / particle budgets /
   overview culling (continue closed #90 spirit). *Restated 2026-09:* this
   originally read "8–12 devices". The live lab passed that while the frame
   budget held, because the constraint that actually binds is overview
   particle/mesh LOD, not a device count — so the number is a floor with a
   gate, not a cap. The gate: a new bench has to teach something no existing
   one does **and** ride the existing catalog pipeline (ADR-0008) rather than
   adding a fourth magic number. `jumping-ring` (15th, Lenz's law as motion —
   the only bench where induction moves a conductor) is the worked example;
   see the device gallery's cross-device-coupling note, which still prefers
   depth over the next bench.

### Explicit non-goals

- Server backend / accounts
- Claiming free-energy metrology
- Full Maxwell FEM in-browser (WASM remains lumped ODEs). A qualitative 2D
  FDTD *wave slice* in the pulse-coil focus view is a different product and
  does not relax this — see [ADR-0010](./0010-fdtd-slice.md).

## Epic checklist

### Workstream 1 — Scene graph + glTF pipeline

- [x] Formal `SceneNode` type (`src/assets/scene/scene-node.ts`)
- [x] Housing shell glTF (closed #102)
- [x] Second CAD prop: coil former GLB in SEG focus
- [x] Node hierarchy polish (lazy multi-prop registry, material overrides)
- [x] **Per-device CAD beyond SEG** — registry entries carry a `deviceId`, and
      `ensureGltfPropsForView()` loads only the focused bench's props while
      disposing every other bench's focus-policy props. Five benches:
      `transformer-core.glb` (the flux path the procedural coils lack),
      `vdg-terminal.glb` (sphere / column / belt / gap, where the shape *is* the
      explanation), `thomson-stand.glb` (the rest shoulder at `h = 0` and the
      travel stop at `poleHeightM`, which the procedural pole has neither of),
      `heron-vessels.glb` (which volume is sealed — the fountain's whole
      argument) and `kelvin-jars.glb` (the shared supply, and collectors on
      insulating pillars rather than standing on nothing).
      Guarded by `npm run test:props`; see `docs/GLTF_ASSETS.md`
- [x] **What stays procedural** — anything whose position or glow *is* the plant
      is not baked: the jumping ring itself (`ringHeightM`), its winding courses
      (`I_p`), Kelvin's induction rings (accumulated charge) and Heron's water.
      CAD covers the bench, not the physics.
- [x] **Preset-shaped benches** — SEG's presets rescale one assembly, so its
      props bake through `worldScale`. Heron's five presets re-route the
      plumbing instead, so `heronVessels` is baked for `classic` only and
      `setHeronLayoutPreset()` re-runs `ensureGltfPropsForView()` to free it
      when the user switches preset without leaving the bench. Pinned in both
      directions by `npm run test:props`
- [x] Optional minimal external glTF parser eval (parser only — not a full engine) — **deferred**: hand-rolled loader wins on gzip; **re-evaluated 2026-09** when multi-device CAD landed and it still parses fine, so still deferred; see `docs/GLTF_ASSETS.md`
- [x] Basis **UASTC** WASM decode evaluated — **not adopted**: GPU-native KTX2 is
      already negotiated per device with zero decode cost, and UASTC's win (one
      container for all formats) is worth nothing against 4×4 solid placeholders.
      Trigger to revisit is a real multi-texture prop set; see `docs/GLTF_ASSETS.md`
- [x] WebGL2: skip heavy glTF or load reduced LODs — documented in `docs/WEBGL2.md`
- [x] Instancing policy documented (procedural rollers vs static CAD) — `docs/GLTF_ASSETS.md`

### Workstream 2 — Cinematic post stack (WebGPU-first)

- [x] Bloom extract / blur / composite
- [x] Filmic curve + exposure from lighting preset
- [x] Cheap SSAO + contact shadow (composite)
- [x] IBL irradiance polish for SEG metals (analytic env mips in `pbr-eval.wgsl`)
- [x] **Prefiltered GGX split-sum IBL** — per lighting preset into an
      octahedral `rgba16float` 2D array, sampled in `pbr-eval.wgsl`; replaces
      the analytic polynomial, which is retained as the pre-upload fallback.
      Always-on (224 KB).
- [x] **IBL bake on the GPU** — `passes/ibl-prefilter-compute.wgsl` +
      `src/ibl-prefilter-gpu.ts`, one dispatch per layer, so the first switch to
      a look no longer blocks the main thread for ~270 ms. The CPU bake
      (`src/ibl-prefilter.ts`, memoised per look) stays as the fallback.
- [x] **Screen-space reflections** for SEG roller chrome/nickel
      (`passes/ssr-compute.wgsl`) — view-space march against the existing depth
      buffer, half-res reflection target composited after SSAO. Gated to the
      high/ultra tier; `?ssr=0` disables at any tier.
- [x] Wire post cost into auto-quality tiers (`post-processing-config.ts` + render loop)
- [x] Document stack + quality gates (`docs/SHADERS.md`, `docs/LIGHTING_RIG.md`)
- [x] CPU↔WGSL uniform contract check in CI (`npm run check:post`)
- [x] Negotiate optional features only when present (`rg11b10ufloat-renderable`, etc.)
      plus soft limits and a labelled `defaultQueue` — see `docs/WEBGPU.md`
- [x] **Temporal AA** — `passes/taa-resolve.wgsl`, reprojected with the camera's
      own view-projection plus the previous frame's, neighbourhood-clamped, with
      `prevSceneTexture` as the history. `high`/`ultra` + focus only; `?taa=0`
      disables; WebGL2 skips it (`docs/WEBGL2.md`).
- [x] **Metalness/roughness G-buffer** — second `rg8unorm` color target on the
      scene render pass (r=metallic, g=roughness), written by
      `seg-enhanced-frag.wgsl`/`roller-frag.wgsl`; `passes/ssr-compute.wgsl`
      samples it (binding 5) to weight reflections by material instead of a
      Fresnel-only grazing term. See `docs/LIGHTING_RIG.md`.

### Workstream 3 — Hardware twin maturation

- [x] Protocol + mock transport (`docs/hardware_connection.md`)
- [x] Shadow residual on TelemetryHub + mock e2e
- [x] Closed-loop: sensor RPM → roller viz (sanitized; NaN-safe)
- [x] Open-loop: sim → coil PWM (duty 0–1 clamp; disconnect coasts)
- [x] Shadow residual charts on scientific UI (`ShadowResidualGauge`)
- [x] Connection state badge (`disconnected` | `mock` | `serial` | `bluetooth` | `usb`)
- [x] Keep firmware optional — never block web-only users
- [x] **WebUSB / Bluetooth where Serial is insufficient** — shipped, not just
      researched. The bridge now speaks to a `HardwareTransport` interface
      (`src/hardware-transport.ts`) and keeps *all* the safety logic, so the
      links are interchangeable: `serial` stays the reference path,
      `bluetooth` (Nordic UART over GATT) covers classroom tables that cannot
      run a cable, `usb` (raw CDC-ACM) exists only for boards the platform
      hides from Web Serial, and `mock` is unchanged. BLE writes are chunked to
      one MTU and queued (GATT ops cannot overlap), and the link asks the bridge
      for a 20 Hz command period — inside both the firmware watchdog (100 ms)
      and the host timeout (200 ms). Disconnect and transport *switching* still
      coast; queued links are flushed so the coast lines reach the board.
      Pinned by `npm run test:transports`; see `docs/hardware_connection.md`.

### Workstream 4 — Performance headroom (14+ benches, LOD-limited)

- [x] Continue LOD / particle budgets (`particle-budgets.ts`, mesh LOD ladder, pipe tiers)
- [x] Overview culling (frustum for 20 m plugin ring + CPU instance prefix)
- [x] GPU compute cull → draw-indirect (`passes/overview-cull-compute.wgsl`,
      `devices/overview-cull.ts`, layout `overviewCull`). One thread per device
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

# SEG WebGPU Visualizer — Agent & Contributor Guide

**Live demo:** https://ford442.github.io/power_gen/

This file is the **architecture map**. Specialized topics live in linked docs; do not treat old line-count comments or git history as source of truth.

---

## Find the entry point (< 5 minutes)

**New here?** (1) `npm install && npm run dev` → http://localhost:5173/ (2) open `src/main.ts` and follow `resolveRenderer()` (3) skim [`adr/`](./adr/) for durable decisions.

| What | Where |
|------|--------|
| **HTML shell / UI** | `src/index.html` (Vite root = `src/`) |
| **App bootstrap** | `src/main.ts` — renderer select, `window.*` APIs, operator wiring |
| **WebGPU scene** | `src/multi-device-visualizer.ts` → `MultiDeviceVisualizer` (GPU backend; plant is `LabSession`) |
| **WebGL2 fallback** | `src/renderers/webgl2/` → `WebGL2MultiDeviceVisualizer` |
| **Lab session** | `src/session/lab-session.ts` — operator, WASM plant, telemetry, energy, twin |
| **Renderer choice** | `src/renderers/renderer-selector.js` |
| **Device list** | `src/devices/device-registry.ts` + `src/devices/device-config.ts` (`DEVICE_CONFIG`) |
| **Shaders** | `src/shaders/` — see [`SHADERS.md`](./SHADERS.md) |
| **C++ / WASM physics** | `cpp/src/sim_core.*` + `src/wasm/seg-physics-bridge.ts` |
| **Telemetry** | `src/telemetry-hub.ts` + `src/telemetry/` — see [`TELEMETRY.md`](./TELEMETRY.md) |
| **Architecture decisions** | [`docs/adr/`](./adr/) (dual renderer, WASM, device catalog, …) |

```text
Browser loads src/index.html
        │
        ▼
   src/main.ts  ── resolveRenderer()
        │
        ▼
   LabSession  (plant, mode, telemetry, energy, twin, wasm)
        ├── MultiDeviceVisualizer (WebGPU pipelines / post / glTF)
        └── WebGL2MultiDeviceVisualizer (GLSL mesh/particles/lines)
                    │
                    ▼
        shared CPU physics (renderers/shared/)
        TelemetryHub.publishFrame each frame
```

**There is no** root-level `main.js` / `multi-device-visualizer.js` tree, and **no** `SEGVisualizer` class. Everything application-related is under `src/`.

### Local run

```bash
npm install
npm run dev          # → http://localhost:5173/  (HTTPS is off; localhost is a secure context)
npm run typecheck
npm run validate     # typecheck + native C++ smoke + WGSL (naga if installed)
```

| Environment | URL |
|-------------|-----|
| Default (**WebGPU required**) | http://localhost:5173/ |
| Agent / no-GPU VM (explicit opt-in) | http://localhost:5173/?renderer=webgl2 |
| WASM plant | `?wasmPhysics=1` |
| Mock hardware twin | `?mockHardware=1` |
| Disable pulse-coil FDTD wave slice | `?fdtd=0` (ADR-0010) |

Default boot **hard-fails** if WebGPU probe fails (no automatic WebGL2).  
Cloud VMs with **no GPU adapter** must pass **`?renderer=webgl2`** intentionally.  
Probe breadcrumbs: `window.webgpuProbe`. Details: root [`AGENTS.md`](../AGENTS.md).

---

## What this product is

Client-side **multi-device physics lab**: real-time visualization of research apparatuses around the Searl Effect Generator (SEG), plus Heron, Kelvin, solar/LED, and experimental devices. **No backend**, no database — static site (GitHub Pages) + optional Web Serial hardware.

| Device id | Role | Fidelity notes (honest) |
|-----------|------|-------------------------|
| `seg` | Searl Effect Generator — rollers, flux, PBR meshes | Highest investment: layout presets, RK4 flux (WebGPU), operator plant |
| `heron` | Heron’s Fountain | Layout presets + Bernoulli/Swamee–Jain plant; good meshes |
| `kelvin` | Kelvin’s Thunderstorm | Capacitive plant + droplet viz |
| `solar` | LEDs + solar + battery | Photon paths + SOC; separate LED/solar TS/WGSL suite exists |
| `peltier` | Thermoelectric | Two-node ΔT/COP telemetry + heat-map plate tint; WASM Seebeck stack (`?wasmPhysics=1`) with matching JS fallback |
| `mhd` | MHD channel | Flow-arrow mesh + Hartmann readout; particles advect with `flowU`/`bField`; WASM Hartmann plant (`?wasmPhysics=1`) |
| `maglev` | Quanta MagLev (plugin) | Spring–damper gap + Halbach B est.; WASM plant with `?wasmPhysics=1` — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) |
| `homopolar` | Quanta Faraday disc (plugin) | L–R + back-EMF; WASM plant with `?wasmPhysics=1` — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) |
| `halbach-viz` | Quanta Halbach viz (plugin) | CPU RK4 field lines + heatmap (JS); see gallery |
| `pulse-coil` | Quanta pulse coil (plugin) | Classroom series R–L + cap discharge + I/V oscilloscope sparkline; **JS plant only (by design)** — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) |
| `transformer` | Quanta mutual induction (plugin) | Two-winding phasor fallback + WASM coupled-inductor ODE (`?wasmPhysics=1`, `SimMode=8`); flux billboards in focus — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md#transformer) |
| `vdg` | Quanta Van de Graaff (plugin) | Belt-charge / isolated-sphere / spark-gap ODE (`?wasmPhysics=1`, `SimMode=9`) + JS fallback; classroom electrostatics, not an HV engineering design — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md#vdg) |
| `hall` | Quanta Hall bench (plugin) | Algebraic `V_H = IB/(net)` (`?wasmPhysics=1`, `SimMode=10`) + JS fallback; **not** a calibrated metrology instrument — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md#hall) |
| `lorentz-sled` | Quanta Lorentz rail sled (plugin) | Lumped R–L + back-EMF + `F = I ℓ × B` vs friction (`?wasmPhysics=1`, `SimMode=11`) + JS fallback mirroring it; no FEM, no contact physics, no projectile — an educational rail motor, **not a railgun design tool** — [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md#lorentz-sled) |

Dashboard overview can enable **all** registered sim devices (typically 6 core + plugins). Particle budgets and mesh detail are **not** equal across devices — auto-quality and view LOD scale further. Do not document “full physical fidelity on every device.”

---

## Technology stack

| Layer | Tech |
|-------|------|
| App / UI | JavaScript ES modules, `src/index.html` |
| Typed physics / integration | TypeScript (`@webgpu/types`) |
| High-precision plant | C++17 → Emscripten WASM (`cpp/`, prebuilt under `src/public/wasm/`) |
| Primary GPU | WebGPU + **WGSL** |
| Fallback GPU | WebGL2 + **GLSL** (`renderers/webgl2/`) |
| Build | **Vite 5**, `root: 'src'`, `outDir: '../dist'`, `server.https: false` |
| Deploy | GitHub Actions Pages (`build:site`); optional Contabo via `deploy.py` |

**Not used:** Three.js, React, a custom game engine. Custom WebGPU/WebGL2 renderers keep control of bind groups, instancing, and offline WGSL validation.

---

## Language strategy

| Language | Own | Do not put |
|----------|-----|------------|
| **JavaScript** | WebGL2 path (`renderers/webgl2/**`), procedural geometry builders (`seg-geometry/**`, `seg-geometry-generators.js`), `multi-device-shaders.js`, `shaders/generators/*` (`?raw` re-exports), `shaders/wgsl-include.js` | New authoritative physics formulas; new device plugin hooks (typed via `devices/types.ts`); dashboard layout (`DEVICE_CONFIG`) |
| **TypeScript** | `main.ts`, `session/`, `multi-device-visualizer.ts`, device registry/config, `device-instance.ts`, visualizer GPU collaborators, WASM bridge, shared url-params/view-lod/device-view, constants (`ValidatedConstants.ts`), `integration.ts`, telemetry, `pipeline-layout-cache.ts`, `devices/types.ts`, core/Quanta strategies, `scientific-ui/**`, `scientific-data.ts`, `seg-explainer/**`, `renderers/renderer-selector.ts`, `renderers/shared/primitive-geometry.ts`, `electromagnet-controller.ts`, `devices/register-plugins.ts`, SEG focus chrome (`seg-annotations`, `seg-diagram-2d`, `seg-materials`, `seg-enhanced-geometry`, `seg-roller-model`, `seg-frame-model`) | WebGL2 GLSL path; Three.js / gl-matrix (ADR-0003) |
| **C++** | `sim_core` plant (SEG rollers RK4, Heron/Kelvin/Solar/Peltier/MHD/Quanta state) | Browser DOM or GPU API calls |
| **WGSL** | WebGPU compute + render (`src/shaders/`) | WebGL2 fallback |
| **GLSL** | WebGL2 only (`renderers/webgl2/shaders.js`) | WebGPU path |
| **Python** | `deploy.py` only | App logic |

**Rules**

- New physics math and public numeric APIs → **TypeScript** (or C++ if part of the WASM plant).
- New draw/compute passes → **WGSL** in `passes/` + layout in `src/pipeline-layout/layouts/*.ts` + [`BINDINGS.md`](./BINDINGS.md); `check:wgsl` + `check:post` when CPU structs couple; document in [`SHADERS.md`](./SHADERS.md). No new `/* wgsl */` in JS.
- New device plugins implement the `DevicePlugin` interface from `src/devices/types.ts` — the single source of truth for plugin hooks and the `DeviceInstanceLike` / `VisualizerLike` shapes. Layout defaults go on `plugin.defaults` (core devices share `DEVICE_CONFIG` from `devices/device-config.ts`).
- `npm run typecheck` covers **`src/**/*.ts` only**. `tsconfig` uses **`allowJs: true` / `checkJs: false`** so JS modules can be imported; remaining JS is not typechecked in CI. JS modules that TS imports may carry a hand-written `.d.ts`.
- Runtime entry is **`src/main.ts`**. `index.ts` is a typed **barrel**, not the app entry.
- Physics constants SoT: `physics/constants.json` → codegen → `ValidatedConstants.ts` (ADR-0002/0006). Wolfram MCP manager was removed; do not reintroduce it on the default boot path.
- **Import style:** JS entry paths import TypeScript modules **extensionless** (e.g. `./telemetry-hub` → `telemetry-hub.ts`). TypeScript sources may use a `.js` emit suffix for cross-file references (`moduleResolution: bundler`). Do not use `from '…ts'` in app code.

### Catalog-driven telemetry chrome (Wave 8 — complete)

| Item | Status |
|------|--------|
| `physics/devices.json` carries a `telemetry` block (label / unit / digits / scale / format) per `telemetryKeys` entry; codegen emits `DEVICE_TELEMETRY_FIELDS` + `TELEMETRY_CSV_DEVICE_COLUMNS` and `check:catalog` hard-fails on a missing unit or a CSV column collision | Done |
| CSV/JSON export widened to v2: base SEG/lab-bus columns + one column per catalog device key; `cpp/src/telemetry_export.h` builds the same header from the generated list (`static_assert` on count drift) | Done |
| Replay feeds device columns back through `publishFrame({ devicePhysics })`, so `hall` / `vdg` / `lorentz-sled` round-trip, not only SEG RPM | Done |
| Operator focus chrome (footer + right-panel readout cells) generated from catalog fields with catalog units — the hand-rolled 14-branch per-device chain and mode-label map are gone | Done |
| One generic `CatalogGaugeStrip` in `scientific-ui/` replaces "a bespoke gauge class per device"; SEG gauges keep SEG focus | Done |

**Not in this wave:** the mode-button row in `src/index.html` still hard-lists its
14 buttons (each carries an emoji the catalog does not model); device setpoint
sliders (Lorentz B, Halbach segments, pulse-coil charge) stay on their existing
APIs per the shared plant-clock rule.

### TypeScript migration (Wave 7 — complete)

| Item | Status |
|------|--------|
| `apply-wasm-plant.ts` derives `WASM_PLANT_MODES` + core/quanta wasm-ownership split from `generated/device-catalog.ts` (ADR-0008) instead of two hand-rolled id arrays | Done |
| `DeviceTelemetrySnap` + `telemetry-hub.ts` gain `vdg`/`hall`/`lorentz-sled` fields matching their catalog `telemetryKeys`; `Partial<>` casts removed from `seg-operator-panel.ts`; `check:catalog` now hard-fails on drift between the catalog and either file | Done |
| Live dashboard: `scientific-ui/**` (gauges + `manager.ts`), `scientific-data.ts` (deleted stub `scientific-data.d.ts`) → `.ts` | Done |
| `#lab=` tours/glossary: `seg-explainer/*` → `.ts` | Done |
| Boot policy + shared geometry: `renderers/renderer-selector.ts`, `renderers/shared/primitive-geometry.ts`, `electromagnet-controller.ts`, `devices/register-plugins.ts` → `.ts` | Done |
| SEG focus chrome: `seg-annotations`, `seg-diagram-2d`, `seg-materials`, `seg-enhanced-geometry`, `seg-roller-model`, `seg-frame-model` → `.ts`; deleted stub `seg-frame-model.d.ts` | Done |

**Still JavaScript (intentional):** `renderers/webgl2/**` (GLSL path, ADR-0001), `seg-geometry/**` + `seg-geometry-generators.js` (procedural builders), `shaders/generators/*` (thin `?raw` re-exports), `shaders/wgsl-include.js` / Vite plugin, `multi-device-shaders.js`. `src/wasm/offline-runner.js` keeps its hand-written `offline-runner.d.ts` (not part of this wave). `src/scientific-ui.js` / `src/scientific-ui-utils.js` are deprecated re-export shims kept for backward compat — import `scientific-ui/index` / `scientific-ui/utils/index` directly instead.

### TypeScript migration (Wave 6 — complete)

| Item | Status |
|------|--------|
| Session-adjacent: `camera-controller`, `multi-device-camera`, `sim-rate-controller`, `energy-pipe`, `performance-profiler`, `post-processing-config`, `seg-lighting-presets`, `seg-layout`, `heron-layout`, `ibl-prefilter` → `.ts` | Done |
| GPU upload / device plumbing: `device-geometry`, `device-uniforms`, `device-compute`, `device-pipeline-manager`, `device-mesh-layouts`, `devices/device-setup`, `devices/overview-cull`, `devices/particle-budgets`, `devices/layout-packer`, `devices/material-roles` → `.ts` | Done |
| Twin / UI chrome: `hardware-bridge`, `hardware-panel`, `hardware-twin-badge`, `debug-panel`, `seg-operator-panel` → `.ts` | Done |
| glTF: `assets/gltf/*` → `.ts`; deleted stub `.d.ts` for `gltf-gpu`, `prop-registry`, `overview-cull`, `layout-packer`, `device-mesh-layouts` | Done |
| Retire Wolfram status panel UI (ADR-0006 follow-up) | Done |

**Still JavaScript (intentional):** `renderers/webgl2/**` (GLSL path, ADR-0001), `seg-geometry/**` (procedural builders), `scientific-ui/gauges/**` (the Wolfram status gauge was removed, not migrated), `shaders/generators/*` (thin `?raw` re-exports), `shaders/wgsl-include.js` / Vite plugin, `multi-device-shaders.js`, `seg-annotations.js`, `electromagnet-controller.js`, `devices/register-plugins.js`, `scientific-data.js`.

### TypeScript migration (Wave 5 — complete)

| Item | Status |
|------|--------|
| Extract `DEVICE_CONFIG` → `devices/device-config.ts`; invert debug-panel import | Done |
| `device-registry.js` → `.ts`; core plugins register layout via `defaults` | Done |
| `device-instance.js` → `.ts` | Done |
| Visualizer mixins → `.ts` (`scene-setup`, `render-loop`, `setup-geometry`, …) | Done |
| `wasm/seg-physics-bridge.js` → `.ts`; delete stub `.d.ts` | Done |
| `assets/scene/scene-node.js` + shared `url-params` / `view-lod` / `device-view` → `.ts` | Done |
| Delete `WolframMCPManager` from default boot; ADR-0006 updated | Done |

**Still JavaScript (as of Wave 5):** WebGL2 path, procedural geometry builders, scientific-ui gauges, debug-panel UI, some device managers (`device-geometry.js`, uniforms/compute/pipeline managers) — see Wave 6 above for the follow-up that migrated debug-panel and the device managers.

### TypeScript migration (Wave 4 — complete)

| Item | Status |
|------|--------|
| `multi-device-visualizer.js`, `main.js` → TS | Done |
| `devices/core/*.js`, `devices/quanta/*.js` strategies → TS | Done |

### TypeScript migration (Wave 3 — complete)

| Item | Status |
|------|--------|
| `devices/types.ts` — canonical `DevicePlugin` + instance/visualizer contracts | Done |
| `pipeline-layout-cache.js` → `.ts` with string-literal layout names | Done |
| `devices/update-helpers.js` → `.ts` | Done |
| `devices/device-update.js` / `device-render.js` → `.ts` | Done |
| `renderers/shared/bind-group-cache.js` → `.ts` | Done |

### TypeScript migration (Wave 2 — complete)

| Item | Status |
|------|--------|
| Normalize imports (no `from '…ts'` in app paths) | Done |
| `telemetry/` modules → `.ts` | Done |
| `telemetry-hub.ts`, `webgpu-manager.ts`, `seg-operator-state.ts` | Done |
| Shared plant (`renderers/shared/*.ts`) | Done (Wave 1) |

---

## Architecture (Vite `root = src/`)

```
power_gen/
├── src/                          # ← Vite root (not repo root)
│   ├── index.html                # Dashboard chrome + canvas
│   ├── main.ts                   # Bootstrap only
│   ├── session/                  # LabSession host (plant, mode, telemetry)
│   ├── multi-device-visualizer.ts
│   ├── visualizer/               # WebGPU GPU collaborators (geometry, post, glTF, frame loop)
│   ├── webgpu-manager.ts
│   ├── pipeline-layout-cache.ts  # Explicit layouts + BindGroupLayoutName
│   ├── device-instance.ts / devices/  # Registry, config, plugins, mixins
│   ├── energy-pipe.ts            # Overview energy transfer viz (+ network)
│   ├── telemetry-hub.ts
│   ├── telemetry/                # Export, replay, sampler, schema (all .ts)
│   ├── seg-operator-state.ts
│   ├── renderers/
│   │   ├── renderer-selector.ts
│   │   ├── shared/               # CPU physics both backends (mostly .ts)
│   │   └── webgl2/               # GLSL fallback (stays JS)
│   ├── shaders/                  # WGSL common/ + passes/ + generators/
│   ├── wasm/                     # Typed bridge + sim.ts → sim_core
│   ├── *.ts                      # Typed physics / integration
│   └── public/wasm/              # Committed sim_core.js + .wasm
├── cpp/                          # Native + Emscripten sources
├── firmware/seg-driver/          # Experimental MCU sketch (see below)
├── docs/                         # This guide + ADRs + domain docs
├── vite.config.js
└── package.json
```

| Path | Entry class | Backend |
|------|-------------|---------|
| Primary | `MultiDeviceVisualizer` | WebGPU |
| Fallback | `WebGL2MultiDeviceVisualizer` | WebGL2 |
| Host | `LabSession` | Shared plant / mode / telemetry |

**Frame loop (both backends):** `LabSession.stepPlant` → backend device visuals → `LabSession.publishFrame` → encode draw.

**WebGPU context (high level):** one adapter/device in `WebGPUManager` (`featureLevel: core` with compatibility retry); depth `depth24plus` or `depth32float` when SSR is on; canvas preferred format, `alphaMode: 'opaque'`, explicit `colorSpace` + `toneMapping`. Full matrix: [`WEBGPU.md`](./WEBGPU.md). WebGL2 gaps: [`WEBGL2.md`](./WEBGL2.md).

Architecture decisions: [`docs/adr/`](./adr/).

---

## Query-parameter matrix

All params are on the page URL search string (e.g. `?renderer=webgl2&wasmPhysics=1`).

| Param | Values | Default | Effect |
|-------|--------|---------|--------|
| `renderer` | `webgpu` \| `webgl2` | **webgpu** (required) | Force backend. `webgl2` is **opt-in only** (not auto-fallback). `localStorage` webgl2 is ignored for default boot. |
| `wasmPhysics` | `1` | off | Enable C++ WASM plant (`seg-physics-bridge`) |
| `wasm` | `1` | off | Alias of `wasmPhysics=1` |
| `gpuTiming` | `1` | off | Request `timestamp-query` feature; enable queries in debug panel after reload |
| `p3` | `1` | off | WebGPU canvas `colorSpace: 'display-p3'` (default `srgb` for CI screenshots) |
| `hdr` | `1` | off | Canvas `toneMapping.mode: 'extended'` **only if** the display reports `(dynamic-range: high)`; bloom composite then outputs linear HDR (`outputLinearHdr`) instead of ACES |
| `capture` | `1` | off | WebGL2 `preserveDrawingBuffer: true` (also on when `navigator.webdriver`) |
| `layout` | `searl` \| `roschin` \| `legacy` | preset default | SEG layout pack |
| `heronLayout` | preset id | stored / default | Heron vessel layout |
| `prototype` | `lab` \| `showroom` \| `searl` \| `roschin` \| `godin` | showroom-ish | SEG roller prototype look / lab effects |
| `frame` | `full` \| `minimal` \| `off` | `full` | SEG structural frame complexity |
| `gltfHousing` | `1` \| `0` | `1` (WebGPU) | Load glTF CAD props in SEG focus — [`GLTF_ASSETS.md`](./GLTF_ASSETS.md) |
| `gltfCoilFormer` | `1` \| `0` | follows housing | Coil former GLB; `0` skips that prop |
| `gltfStand` | `1` \| `0` | follows housing | Stand GLB; `0` skips that prop |
| `gltfBasePlate` | `1` \| `0` | follows housing | Base plate GLB; `0` skips that prop |
| `look` / `lighting` | `studio` \| `lab` \| `drama` | `studio` | Lighting + post look |
| `mockHardware` | `1` | off | Hardware twin mock transport (no serial port) |
| `energyCoupling` | `1` \| `0` | off (visual-only pipes) | Clamp overview pipe flow by simulated lab power budget (`EnergyNetwork`) |
| `replay` | `1` | off | Show telemetry replay scrubber (load `.seg-replay.json` / CSV; plant step bypassed) |
| `gpuChores` | `0` / `js` / `wasm` / `webgpu` | auto | Meter backend kill / force. `0` = JS goldens. Never opens a second GPU API. |

**Related (not always query):**

| Mechanism | Purpose |
|-----------|---------|
| `#lab=…` hash | SEG Explainer shareable lab state — [`SEG_EXPLAINER.md`](./SEG_EXPLAINER.md) |
| `localStorage useWasmPhysics` | Persist WASM physics toggle |
| `localStorage seg-energy-coupling` | Persist coupled vs visual-only energy pipes |
| `localStorage heron-layout` | Persist Heron preset |
| `localStorage seg-sim-seed` | Deterministic RNG seed for telemetry/replay |

Example:

```text
http://localhost:5173/?renderer=webgl2&wasmPhysics=1&layout=searl&look=lab&frame=minimal
```

---

## Key modules (roles, not line counts)

| Module | Role |
|--------|------|
| `src/main.ts` | Renderer bootstrap, window control API, WASM badge, operator/diagram init |
| `src/session/lab-session.ts` | Shared lab host: operator, WASM plant, mode, energy network, twin, telemetry |
| `src/multi-device-visualizer.ts` | WebGPU backend: devices, pipes, bloom, frame encode, glTF |
| `src/visualizer/*.ts` | Named WebGPU collaborators (not prototype mixins) |
| `src/webgpu-manager.ts` | Single adapter/device/canvas/depth path |
| `src/pipeline-layout-cache.ts` | Shared bind-group layouts + pipelines |
| `src/device-instance.ts` + `devices/*` | Per-device update/render mixins, registry plugins, `device-config.ts` |
| `src/energy-pipe.ts` | Overview Bézier energy transfer (visual; `EnergyNetwork` in `renderers/shared/`) |
| `src/performance-profiler.ts` | FPS, auto-quality, optional GPU timestamps, per-device CPU times |
| `src/sim-rate-controller.ts` | Speed mult / substeps; couples to quality under load |
| `src/telemetry-hub.ts` | Single telemetry write path for gauges / operator |
| `src/seg-operator-state.ts` | Authoritative SEG plant (drive, RPM, V/I/P) |
| `src/seg-layout.ts` | Layout presets (Searl / Roschin / legacy) — data-driven roller counts |
| `src/assets/scene/scene-node.ts` | Formal scene graph node (ADR-0005) |
| `src/assets/gltf/*` | Hand-rolled glTF loader + lazy prop registry — [`GLTF_ASSETS.md`](./GLTF_ASSETS.md) |
| `src/integration.ts` | Typed physics uniforms + scientific overlay hooks |
| `src/wasm/seg-physics-bridge.ts` | Optional WASM step + zero-copy views |
| `src/hardware-bridge.ts` / `hardware-panel.ts` | Web Serial + mock twin (**experimental**) |
| `src/renderers/shared/*` | CPU particle + plant steps for both backends |

---

## Hardware & firmware (experimental)

| Piece | Status |
|-------|--------|
| `src/hardware-bridge.ts` + panel | **Experimental** — mock works (`?mockHardware=1`); real Web Serial depends on browser + device |
| `firmware/seg-driver/` | **Experimental** Arduino-style coil/sensor sketch; not required for the web app |
| Safety | Disconnect coasts coils; see [`hardware_connection.md`](./hardware_connection.md) |

Do not present firmware as production-ready or as a CI dependency. The visualizer runs fully without hardware.

---

## Commands & CI

```bash
npm run dev           # Vite → http://localhost:5173/
npm run build:site    # vite build (uses committed WASM)
npm run build         # wasm:build + build:site (needs emcc / EMSDK)
npm run typecheck     # tsc --noEmit
npm run check:wgsl    # extract includes → naga
npm run check:post    # CPU↔WGSL post contracts
npm run validate      # typecheck + wasm:native + check:post + check:wgsl
npm run wasm:native   # g++ smoke test, no Emscripten
npm run wasm:build    # scripts/build-wasm.sh
```

| Workflow | What |
|----------|------|
| `.github/workflows/static.yml` | typecheck + `build:site` → Pages |
| `.github/workflows/validate.yml` | typecheck, site build, native C++, WGSL (`REQUIRE_NAGA=1`) |
| `.github/workflows/build-wasm.yml` | WASM rebuild when enabled |

---

## Performance (overview)

- Auto-quality scales particles; overview applies **view LOD** (`renderers/shared/view-lod.ts`).
- **Per-device particle budgets** by quality tier live in `devices/particle-budgets.ts`
  (plugins default lower than SEG/core; `resolveScaledParticleCount` caps draws).
- Overview **mesh LOD ladder**: `full → simplified → proxy → skip` via `getMeshDrawDetail`
  (non-SEG cylinder instance prefix; SEG still uses layout `decimateCount` + roller cull).
- Frustum skip uses `getOverviewCullOpts` sized for the **20 m** plugin layout ring
  (`layout-packer` / registry `applyAutoLayout({ radius: 20 })`).
- Energy-pipe particle counts follow `qualityTier` (`resolvePipeParticleBudget`).
- Mid-tier target: overview **≥45 FPS** with all devices on — document the adapter via
  F3 debug panel (`Adapter` + `GPU Tier` + `Draw calls (est.)` + per-device CPU ms).
- Focus SEG keeps full quality relative to the quality tier.
- Post cost is also tiered when the showroom stack is present (ADR-0005 WS2) —
  particles/mesh remain the first cut; post follows on low FPS.
- Details: profiler (F3 / Ctrl+D), [`SHADERS.md`](./SHADERS.md) for WGSL cost.
- Instance cull today is **CPU prefix** (draw first N / SEG roller half-ring). Full GPU
  frustum compute for plugins is optional follow-up (ADR-0005 WS4).

---

## Testing

Playwright E2E (headless Chromium, `?renderer=webgl2`):

```bash
npm run test:e2e          # starts Vite dev server automatically
npm run dev               # or run dev manually, then: npx playwright test
```

Covers page boot, START → telemetry, mode focus, `captureCanvasFrame`, and optional `?wasmPhysics=1`
(each WASM-backed plugin device has a `setMode(id)` + plant smoke and a JS-fallback pair).
CI: `validate.yml` job **Playwright (WebGL2)** on PRs.

Manual / agent checks (WebGPU needs a real GPU):

1. `?renderer=webgl2` — START plant, non-zero telemetry, mode focus buttons.
2. WebGPU (real GPU) — same + bloom/flux where quality allows.
3. `npm run validate` before merge when touching physics/shaders/native.
4. Agent hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`, `window.currentRenderer`.

---

## Doc index

| Doc | Topic |
|-----|--------|
| [`adr/`](./adr/) | Architecture decision records |
| [`SHADERS.md`](./SHADERS.md) | WGSL includes, particle layout, naga, post stack |
| [`BINDINGS.md`](./BINDINGS.md) | Bind group contracts |
| [`WEBGPU.md`](./WEBGPU.md) | Adapter/device/context |
| [`WEBGL2.md`](./WEBGL2.md) | Fallback parity gaps |
| [`TELEMETRY.md`](./TELEMETRY.md) | TelemetryHub |
| [`LIGHTING_RIG.md`](./LIGHTING_RIG.md) | Lighting looks + post quality gates |
| [`GLTF_ASSETS.md`](./GLTF_ASSETS.md) | SceneNode + glTF CAD props |
| [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) | Devices & plugins |
| [`SEG_EXPLAINER.md`](./SEG_EXPLAINER.md) | Guided learning / `#lab=` |
| [`hardware_connection.md`](./hardware_connection.md) | Twin protocol |
| [`../cpp/README.md`](../cpp/README.md) | WASM core |
| [`../claude.md`](../claude.md) | Short agent checklist (keep in sync with this file) |

---

## Future / north star

Long-range product shape (**Showroom / Lab / Twin**) is tracked in
[**ADR-0005**](./adr/0005-showroom-lab-twin-epic.md): formal `SceneNode` + glTF CAD,
cinematic WebGPU post, optional hardware twin, multi-device performance headroom.
Do **foundation** issues first (WASM, TS, energy network, shader CI); treat ADR-0005
as the graphics/content epic once the plant stays maintainable.

---

## Extension points

- **New apparatus:** catalog row in `physics/devices.json` + plugin + plant (if `wasmMode` set). Do not add a fourth magic map.
- **New shader pass:** `.wgsl` in `passes/` + layout name in `pipeline-layout/` + BINDINGS row + `check:wgsl` (+ `check:post` if CPU struct).
- **New plant mode in WASM:** next `reservedWasmModes` slot in the catalog, then `cpp/src/sim_core.*`. Bridge `setMode` takes a device **id**, not `shaderMode`.
- **Energy coupling:** pipes are visual today; physical network intent is ADR-0004.

## Code style (short)

- ES modules; async WebGPU init. Import extension convention: see "Import style" above.
- Prefer explicit WGSL types and documented bindings over `layout: 'auto'`.
- Physics numbers: [`physics/constants.json`](../physics/constants.json) → codegen ([`docs/PHYSICS_CONSTANTS.md`](PHYSICS_CONSTANTS.md)). Device identity: [`physics/devices.json`](../physics/devices.json) → `npm run codegen:catalog` ([`MODE_MATRIX.md`](MODE_MATRIX.md)). Layout presets stay in `seg-layout.ts`.

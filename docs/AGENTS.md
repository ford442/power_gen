# SEG WebGPU Visualizer — Agent & Contributor Guide

**Live demo:** https://ford442.github.io/power_gen/

This file is the **architecture map**. Specialized topics live in linked docs; do not treat old line-count comments or git history as source of truth.

---

## Find the entry point (< 5 minutes)

| What | Where |
|------|--------|
| **HTML shell / UI** | `src/index.html` (Vite root = `src/`) |
| **App bootstrap** | `src/main.js` — renderer select, `window.*` APIs, operator wiring |
| **WebGPU scene** | `src/multi-device-visualizer.js` → `MultiDeviceVisualizer` |
| **WebGL2 fallback** | `src/renderers/webgl2/` → `WebGL2MultiDeviceVisualizer` |
| **Renderer choice** | `src/renderers/renderer-selector.js` |
| **Device list** | `src/devices/device-registry.js` + `debug-panel.js` `DEVICE_CONFIG` |
| **Shaders** | `src/shaders/` — see [`SHADERS.md`](./SHADERS.md) |
| **C++ / WASM physics** | `cpp/src/sim_core.*` + `src/wasm/seg-physics-bridge.js` |
| **Telemetry** | `src/telemetry-hub.js` — see [`TELEMETRY.md`](./TELEMETRY.md) |

```text
Browser loads src/index.html
        │
        ▼
   src/main.js  ── resolveRenderer() ──► WebGPU MultiDeviceVisualizer
                              │            or WebGL2MultiDeviceVisualizer
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
| Default (WebGPU if available) | http://localhost:5173/ |
| Agent / no-GPU VM | http://localhost:5173/?renderer=webgl2 |
| WASM plant | `?wasmPhysics=1` |
| Mock hardware twin | `?mockHardware=1` |

Cloud VMs often have **no GPU adapter** — use WebGL2. Details: root [`AGENTS.md`](../AGENTS.md) (Cursor Cloud notes).

---

## What this product is

Client-side **multi-device physics lab**: real-time visualization of research apparatuses around the Searl Effect Generator (SEG), plus Heron, Kelvin, solar/LED, and experimental devices. **No backend**, no database — static site (GitHub Pages) + optional Web Serial hardware.

| Device id | Role | Fidelity notes (honest) |
|-----------|------|-------------------------|
| `seg` | Searl Effect Generator — rollers, flux, PBR meshes | Highest investment: layout presets, RK4 flux (WebGPU), operator plant |
| `heron` | Heron’s Fountain | Layout presets + Bernoulli/Swamee–Jain plant; good meshes |
| `kelvin` | Kelvin’s Thunderstorm | Capacitive plant + droplet viz |
| `solar` | LEDs + solar + battery | Photon paths + SOC; separate LED/solar TS/WGSL suite exists |
| `peltier` | Thermoelectric | Geometry + particle modes; **lighter** plant model |
| `mhd` | MHD channel | Geometry + particles; **lighter** plant model |
| `maglev` | Quanta MagLev (plugin) | Plugin registry; see [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) |

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
| **JavaScript** | Bootstrap, multi-device orchestration, geometry buffers, UI wiring, WebGL2 path | New authoritative physics formulas (prefer TS) |
| **TypeScript** | Constants (`ValidatedConstants.ts`), `integration.ts`, WASM types, LED/solar protocol | Full render loops (until a deliberate migration) |
| **C++** | `sim_core` plant (SEG rollers RK4, Heron/Kelvin/Solar state) | Browser DOM or GPU API calls |
| **WGSL** | WebGPU compute + render (`src/shaders/`) | WebGL2 fallback |
| **GLSL** | WebGL2 only (`renderers/webgl2/shaders.js`) | WebGPU path |
| **Python** | `deploy.py` only | App logic |

**Rules**

- New physics math and public numeric APIs → **TypeScript** (or C++ if part of the WASM plant).
- New draw/compute passes → **WGSL** + `pipeline-layout-cache.js` + [`BINDINGS.md`](./BINDINGS.md); document in [`SHADERS.md`](./SHADERS.md).
- `npm run typecheck` covers **`src/**/*.ts` only** (`allowJs: false`). JS is not typechecked in CI.
- Runtime entry is **`main.js`**. `index.ts` is a typed **barrel**, not the app entry.

---

## Architecture (Vite `root = src/`)

```
power_gen/
├── src/                          # ← Vite root (not repo root)
│   ├── index.html                # Dashboard chrome + canvas
│   ├── main.js                   # Bootstrap only
│   ├── multi-device-visualizer.js
│   ├── webgpu-manager.js
│   ├── pipeline-layout-cache.js  # Explicit layouts; no layout:'auto' in prod
│   ├── device-*.js / devices/    # Per-device geometry, update, render, plugins
│   ├── energy-pipe.js            # Overview energy transfer viz (+ network)
│   ├── telemetry-hub.js
│   ├── renderers/
│   │   ├── renderer-selector.js
│   │   ├── shared/               # CPU physics both backends
│   │   └── webgl2/
│   ├── shaders/                  # WGSL common/ + passes/ + generators/
│   ├── wasm/                     # JS bridge to sim_core
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

**Frame loop (both backends):** SimRateController substeps → optional WASM plant → per-device update → `TelemetryHub.publishFrame` → encode draw.

**WebGPU context (high level):** one `requestAdapter` / device in `WebGPUManager`; depth `depth24plus`; canvas preferred format, `alphaMode: 'opaque'`. Full matrix: [`WEBGPU.md`](./WEBGPU.md). WebGL2 gaps: [`WEBGL2.md`](./WEBGL2.md).

Architecture decisions: [`docs/adr/`](./adr/).

---

## Query-parameter matrix

All params are on the page URL search string (e.g. `?renderer=webgl2&wasmPhysics=1`).

| Param | Values | Default | Effect |
|-------|--------|---------|--------|
| `renderer` | `webgpu` \| `webgl2` | auto (`webgpu` if `navigator.gpu`, else webgl2) | Force backend; also `localStorage` key `seg-renderer`, `window.DEBUG_RENDERER` |
| `wasmPhysics` | `1` | off | Enable C++ WASM plant (`seg-physics-bridge`) |
| `wasm` | `1` | off | Alias of `wasmPhysics=1` |
| `gpuTiming` | `1` | off | Request `timestamp-query` feature; enable queries in debug panel after reload |
| `layout` | `searl` \| `roschin` \| `legacy` | preset default | SEG layout pack |
| `heronLayout` | preset id | stored / default | Heron vessel layout |
| `prototype` | `lab` \| `showroom` \| `searl` \| `roschin` \| `godin` | showroom-ish | SEG roller prototype look / lab effects |
| `frame` | `full` \| `minimal` \| `off` | `full` | SEG structural frame complexity |
| `look` / `lighting` | `studio` \| `lab` \| `drama` | `studio` | Lighting + post look |
| `mockHardware` | `1` | off | Hardware twin mock transport (no serial port) |

**Related (not always query):**

| Mechanism | Purpose |
|-----------|---------|
| `#lab=…` hash | SEG Explainer shareable lab state — [`SEG_EXPLAINER.md`](./SEG_EXPLAINER.md) |
| `localStorage useWasmPhysics` | Persist WASM physics toggle |
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
| `main.js` | Renderer bootstrap, window control API, WASM badge, operator/diagram init |
| `multi-device-visualizer.js` | WebGPU orchestrator: devices, pipes, bloom, frame loop, hardware twin hook |
| `webgpu-manager.js` | Single adapter/device/canvas/depth path |
| `pipeline-layout-cache.js` | Shared bind-group layouts + pipelines |
| `device-instance.js` + `devices/*` | Per-device update/render mixins, registry plugins |
| `energy-pipe.js` | Overview Bézier energy transfer (visual; network intent in ADR) |
| `performance-profiler.js` | FPS, auto-quality, optional GPU timestamps, per-device CPU times |
| `sim-rate-controller.js` | Speed mult / substeps; couples to quality under load |
| `telemetry-hub.js` | Single telemetry write path for gauges / operator |
| `integration.ts` | Typed physics uniforms + scientific overlay hooks |
| `wasm/seg-physics-bridge.js` | Optional WASM step + zero-copy views |
| `hardware-bridge.js` / `hardware-panel.js` | Web Serial + mock twin (**experimental**) |
| `renderers/shared/*` | CPU particle + plant steps for both backends |

---

## Hardware & firmware (experimental)

| Piece | Status |
|-------|--------|
| `src/hardware-bridge.js` + panel | **Experimental** — mock works (`?mockHardware=1`); real Web Serial depends on browser + device |
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
npm run check:wgsl    # extract includes/generators → naga
npm run validate      # typecheck + wasm:native + check:wgsl
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

- Auto-quality scales particles; overview applies **view LOD** (see `renderers/shared/view-lod.js`).
- Mid-tier target: overview ≥45 FPS with all devices on (document adapter via debug panel).
- Focus SEG should keep full quality relative to the quality tier.
- Details: profiler debug panel (F3 / Ctrl+D), [`SHADERS.md`](./SHADERS.md) for WGSL cost.

---

## Testing

No full automated browser suite. Manual / agent checks:

1. `?renderer=webgl2` — START plant, non-zero telemetry, mode focus buttons.
2. WebGPU (real GPU) — same + bloom/flux where quality allows.
3. `npm run validate` before merge when touching physics/shaders/native.
4. Agent hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`, `window.currentRenderer`.

---

## Doc index

| Doc | Topic |
|-----|--------|
| [`adr/`](./adr/) | Architecture decision records |
| [`SHADERS.md`](./SHADERS.md) | WGSL includes, particle layout, naga |
| [`BINDINGS.md`](./BINDINGS.md) | Bind group contracts |
| [`WEBGPU.md`](./WEBGPU.md) | Adapter/device/context |
| [`WEBGL2.md`](./WEBGL2.md) | Fallback parity gaps |
| [`TELEMETRY.md`](./TELEMETRY.md) | TelemetryHub |
| [`DEVICE_GALLERY.md`](./DEVICE_GALLERY.md) | Devices & plugins |
| [`SEG_EXPLAINER.md`](./SEG_EXPLAINER.md) | Guided learning / `#lab=` |
| [`hardware_connection.md`](./hardware_connection.md) | Twin protocol |
| [`../cpp/README.md`](../cpp/README.md) | WASM core |
| [`../claude.md`](../claude.md) | Short agent checklist (keep in sync with this file) |

---

## Extension points

- **New apparatus:** `devices/register-plugins.js` / Quanta plugins — avoid hardcoding into the visualizer when possible.
- **New shader pass:** `docs/SHADERS.md` checklist + `pipeline-layout-cache` + BINDINGS.
- **New plant mode in WASM:** `cpp/src/sim_core.*` + bridge mode switch.
- **Energy coupling:** pipes are visual today; physical network intent is ADR-0004.

## Code style (short)

- ES modules with `.js` import suffixes; async WebGPU init.
- Prefer explicit WGSL types and documented bindings over `layout: 'auto'`.
- Physics numbers: TS constants or C++ — not magic literals scattered in render code.

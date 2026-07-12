# Copilot Instructions

**Canonical map:** [`docs/AGENTS.md`](../docs/AGENTS.md) · **Short checklist:** [`claude.md`](../claude.md) · **ADRs:** [`docs/adr/`](../docs/adr/)

## Build, run, and validation

```bash
npm install
npm run dev          # http://localhost:5173/  (Vite https: false)
npm run typecheck
npm run validate     # typecheck + native C++ smoke + WGSL (naga in CI)
npm run build:site   # Vite → dist/ (uses committed WASM)
npm run preview      # preview dist/
```

- **Single app surface:** everything ships from **`src/`** (Vite `root: 'src'`). There is **no** root-level `index.html` / `main.js` tree and **no** `SEGVisualizer` class.
- **GitHub Pages** builds `dist/` via [`.github/workflows/static.yml`](./workflows/static.yml) (`npm run build:site`, artifact `dist/`). Do not serve the repo root as the app.
- **Local dev URL:** `http://localhost:5173/` — not HTTPS. Localhost is a secure context for WebGPU.
- **No-GPU / agents:** `http://localhost:5173/?renderer=webgl2`

## Entry points (< 5 minutes)

| What | Path |
|------|------|
| HTML | `src/index.html` |
| Bootstrap | `src/main.js` |
| WebGPU orchestrator | `src/multi-device-visualizer.js` |
| WebGL2 fallback | `src/renderers/webgl2/` |
| Renderer select | `src/renderers/renderer-selector.js` |
| Shaders | `src/shaders/` — [`docs/SHADERS.md`](../docs/SHADERS.md) |
| WASM plant | `cpp/` + `src/wasm/seg-physics-bridge.js` |

## Architecture (high level)

```
src/main.js → resolveRenderer() → MultiDeviceVisualizer (WebGPU)
                               or WebGL2MultiDeviceVisualizer
         shared CPU physics (src/renderers/shared/)
         TelemetryHub.publishFrame each frame
```

| Module | Role |
|--------|------|
| `webgpu-manager.js` | Single `requestAdapter` / device / canvas / depth |
| `pipeline-layout-cache.js` | Explicit bind-group layouts + pipelines |
| `device-instance.js` + `devices/*` | Per-device update/render; plugin registry |
| `performance-profiler.js` + `debug-panel.js` | FPS, auto-quality, `DEVICE_CONFIG` |
| `energy-pipe.js` | Overview energy transfer (visual; ADR-0004) |
| `hardware-bridge.js` | Web Serial twin — **experimental** (`?mockHardware=1`) |

**Dual renderer** (ADR-0001): WebGPU primary, WebGL2 fallback. Shared plant in `renderers/shared/`; visual gaps documented in `docs/WEBGL2.md`.

**Devices:** Core ids `seg`, `heron`, `kelvin`, `solar`, `peltier`, `mhd` (+ plugins e.g. `maglev`). Fidelity is **uneven** — SEG is highest; Peltier/MHD are lighter. See device table in `docs/AGENTS.md`.

## Query parameters

Full matrix: **`docs/AGENTS.md` → Query-parameter matrix**. Common flags:

| Param | Effect |
|-------|--------|
| `renderer=webgl2` | Force WebGL2 |
| `wasmPhysics=1` | C++ WASM plant |
| `gpuTiming=1` | Request timestamp-query (enable in debug panel after reload) |
| `layout` / `heronLayout` | SEG / Heron layout presets |
| `mockHardware=1` | Mock hardware twin (no serial) |

## Conventions

- **ES modules** with explicit `.js` import suffixes.
- **New physics math** → TypeScript (`src/*.ts`) or C++ WASM — not scattered JS literals.
- **New WGSL passes** → `src/shaders/passes/` + `#include "common/…"` + `pipeline-layout-cache.js` + `docs/BINDINGS.md`. Run `npm run check:wgsl`.
- **Do not** import `wgsl-include.js` in browser code (Node/CI only; Vite plugin expands `#include`).
- **Mode indices** in shaders: `0=seg`, `1=heron`, `2=kelvin`, `3=solar`, `4=peltier`, `5=mhd` — keep JS uniform writes aligned.
- **`npm run typecheck`** covers `src/**/*.ts` only (`allowJs: false`).

## Hardware / firmware

**Experimental** — not required for the web app or CI. Mock demo: `?mockHardware=1`. Firmware: `firmware/seg-driver/`. Spec: `docs/hardware_connection.md`.

## Browser / agent testing

- Hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`, `window.currentRenderer`
- Operator flow: START → non-zero telemetry; mode focus buttons; optional `?wasmPhysics=1`
- WebGL2 debug keys: `W` wireframe, `P` particles, `N` normals, `Space` pause

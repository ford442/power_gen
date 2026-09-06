# Claude / agent checklist — SEG WebGPU Visualizer

**Canonical architecture:** [`docs/AGENTS.md`](docs/AGENTS.md)  
**ADRs:** [`docs/adr/`](docs/adr/)  
**Live demo:** https://ford442.github.io/power_gen/

## Entry (read this first)

| Item | Path |
|------|------|
| HTML | `src/index.html` |
| Bootstrap | `src/main.ts` |
| WebGPU | `src/multi-device-visualizer.ts` |
| WebGL2 | `src/renderers/webgl2/` |
| Select backend | `src/renderers/renderer-selector.js` |
| Device layout | `src/devices/device-config.ts` |
| ADRs | `docs/adr/` |

Vite **`root: 'src'`**. There is **no** root-level app tree and **no** `SEGVisualizer`.  
**Contributor map:** `docs/AGENTS.md` (query params, language roles, device fidelity).

## Run

```bash
npm install
npm run dev          # http://localhost:5173/  (https: false; localhost is fine for WebGPU)
```

| Goal | URL |
|------|-----|
| No GPU / agents | `http://localhost:5173/?renderer=webgl2` (required — default WebGPU hard-fails without GPU) |
| WASM plant | `?wasmPhysics=1` |
| Mock hardware | `?mockHardware=1` |

Default boot no longer falls back to WebGL2. Probe: `window.webgpuProbe`.

Full query matrix: **docs/AGENTS.md → Query-parameter matrix**.

## Dual renderer

| Path | Class | Backend |
|------|--------|---------|
| Primary | `MultiDeviceVisualizer` | WebGPU + WGSL |
| Fallback | `WebGL2MultiDeviceVisualizer` | WebGL2 + GLSL |

Shared CPU physics: `src/renderers/shared/`. Plant host: `src/session/`. Gaps: **docs/WEBGL2.md**.  
Hooks: `window.currentRenderer`, `window.getRendererInfo()`, `window.captureCanvasFrame()`.

## Language roles (short)

| Use | For |
|-----|-----|
| **JS** | WebGL2, geometry builders, scientific-ui, debug-panel |
| **TS** | Bootstrap, visualizer, registry/config, constants, WASM bridge |
| **C++/WASM** | Optional plant (`?wasmPhysics=1`) |
| **WGSL** | WebGPU shaders (`src/shaders/`) |
| **GLSL** | WebGL2 only |

Details: docs/AGENTS.md → Language strategy. Shaders: **docs/SHADERS.md**.

## Devices (fidelity is uneven)

Registered core ids: `seg`, `heron`, `kelvin`, `solar`, `peltier`, `mhd`
(+ Quanta plugins: `maglev`, `homopolar`, `halbach-viz`, `pulse-coil`).
WASM plants: `physics/devices.json` `wasmMode` (codegen `enum SimMode`). Shader
slots are a separate `shaderMode` namespace — see docs/MODE_MATRIX.md.

- **SEG** is the highest-fidelity path (layout presets, flux, PBR).
- **Peltier / MHD** are lighter models — geometry + particles, not full plant parity.
- Overview can enable all; particles/meshes scale with quality and view LOD.

## Hardware / firmware — experimental

- Web Serial + mock: `hardware-bridge.ts` / panel — demo with `?mockHardware=1`.
- `firmware/seg-driver/` is **not** required for the web app; treat as experimental.
- Spec: **docs/hardware_connection.md**.

## Commands

```bash
npm run typecheck
npm run codegen:catalog  # physics/devices.json → TS/C++/WGSL/docs
npm run validate      # constants + catalog + typecheck + native C++ + check:post + WGSL
npm run build:site    # no Emscripten
npm run check:wgsl    # naga offline
npm run check:post    # post uniform contracts
```

## WebGPU notes

- One adapter path: `webgpu-manager.ts`. Depth: `depth24plus` (or `depth32float` when SSR is on). Canvas: `colorSpace` sRGB (`?p3=1` for Display P3).
- GPU timing: `?gpuTiming=1` then debug panel.
- Details: **docs/WEBGPU.md**.

## Do not

- Assume HTTPS on the Vite dev server (it is HTTP on localhost).
- Document non-existent root `main.js` / dual architecture trees.
- Claim every device has equal physical fidelity.
- Import `wgsl-include.js` into browser code (Node/CI only; Vite expands `#include`).

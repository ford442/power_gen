# AGENTS.md

A detailed architecture/code guide lives in `docs/AGENTS.md`. This file adds
environment-specific notes for agents working in Cursor Cloud.

## Cursor Cloud specific instructions

This is a single-product, client-side web app (the **SEG WebGPU Visualizer**)
built with **Vite**. There is no backend, database, or server-side service.

### Services & commands

- **Dev server (only required service):** `npm run dev` serves the app at
  `http://localhost:5173/`. Vite's root is `src/`, so the dev server serves
  `src/index.html` (the multi-device dashboard).
- **Build (site / Pages):** `npm run build:site` (plain `vite build`). Use this
  for routine checks and deploys. Prebuilt WASM is committed under
  `src/public/wasm/`.
- **Build (full, needs Emscripten):** `npm run build` → `wasm:build` then
  `build:site`. `wasm:build` runs `scripts/build-wasm.sh`, which finds `emcc`
  on PATH or via `EMSDK=/path/to/emsdk` (no hardcoded machine paths).
- **Validate:** `npm run validate` → typecheck + native C++ smoke + WGSL (naga
  if installed). CI: `.github/workflows/validate.yml`.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit` over `src/**/*.ts` with
  `@webgpu/types`). Also runs in Pages deploy (`static.yml`) and `validate.yml`.

### Browser testing caveat (important)

- This VM has **no GPU adapter**, so **WebGPU does not work** here. Loading the
  default `http://localhost:5173/` shows a "WebGPU init failed: No adapter" alert
  and renders a black canvas.
- For any browser-based testing, use the **WebGL2 fallback**:
  `http://localhost:5173/?renderer=webgl2`. Full operator workflow works:
  START → non-zero RPM/V/I/P (TelemetryHub), mode buttons focus devices,
  SEG/Heron layout presets, optional `?wasmPhysics=1`. Debug keys: `W` wireframe,
  `P` particle debug, `N` normals, `Space` pause, `.` step, `[` / `]` slow-mo.
- CI hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`.
- **Intentional WebGL2 visual gaps** (bloom, RK4 flux, energy arcs, enhanced PBR):
  see **`docs/WEBGL2.md`**.
- Dashboard telemetry is **TelemetryHub** only (`src/telemetry-hub.js`); both
  renderers call `publishFrame` after physics.
- Because the WebGPU path can't run here, you cannot catch WGSL compile/validation
  errors in a browser. To check WGSL offline, validate with `naga` (e.g.
  `cargo install naga-cli --version 0.19.0 --locked`, then `naga shader.wgsl`).
  The inline WGSL in `src/multi-device-shaders.js` is in plain template literals
  (no `${}`), so it can be extracted/validated directly. Note: naga is stricter
  than Chrome's Tint in places — e.g. it rejects dynamic indexing of `let`/`const`
  value arrays (`arr[i]`), which Tint/Chrome actually allow.

### C++ WASM physics path

High-precision C++ core: `cpp/src/sim_core.cpp` (v1.1). Bridge: `src/wasm/seg-physics-bridge.js`.

| Mode | Plant state |
|------|-------------|
| SEG | RK4 rollers (66) |
| Heron | head / Bernoulli+Swamee–Jain vExit |
| Kelvin | capacitive V, spark, E |
| Solar | battery SOC |

Enable: `?wasmPhysics=1` or debug panel toggle (localStorage). Multi-device calls
`segWasm.step` + mode switch when enabled. **Zero-copy:** `getParticleFloatView()` /
`getRollerStateFloatView()` via `HEAPF32` (live metric: `lastRollerMeanOmega`).
Debug panel: JS vs WASM step/s benchmark + optional particle radius diff.
Docs: `cpp/README.md`.
### Hardware digital twin

- Bridge: `src/hardware-bridge.js` (Web Serial + **Mock** transport)
- UI: **Hardware Twin** left-sidebar panel (`src/hardware-panel.js`)
- Modes: open-loop (sim→HW), closed-loop (HW→rollers), shadow (Δφ/ΔRPM)
- Safety: disconnect coasts coils (`P0,0,2` + `C0,0,0`); host timeout → coast
- Demo: `?mockHardware=1` or panel **Mock** button
- Spec: `docs/hardware_connection.md`

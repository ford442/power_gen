# AGENTS.md

**Full architecture map:** [`docs/AGENTS.md`](docs/AGENTS.md)  
**ADRs:** [`docs/adr/`](docs/adr/)  
**Short checklist:** [`claude.md`](claude.md)

This file adds **Cursor Cloud / headless VM** notes only.

## Cursor Cloud specific instructions

Single-product, client-side app (**SEG WebGPU Visualizer**), Vite `root: 'src/'`.
No backend, database, or server-side service.

### Services & commands

- **Dev server:** `npm run dev` → **`http://localhost:5173/`** (not HTTPS; Vite
  `server.https: false`). Serves `src/index.html`.
- **Build (Pages):** `npm run build:site`. Prebuilt WASM: `src/public/wasm/`.
- **Build (full):** `npm run build` (needs `emcc` or `EMSDK`).
- **Validate:** `npm run validate` → typecheck + native C++ + WGSL.
- **Typecheck:** `npm run typecheck` (`src/**/*.ts` only).

### Browser testing caveat (important)

- This VM has **no GPU adapter** → WebGPU fails (“No adapter”). Always use:
  **`http://localhost:5173/?renderer=webgl2`**
- Operator flow: START → non-zero RPM/V/I/P (TelemetryHub), mode focus,
  SEG/Heron layouts, optional `?wasmPhysics=1`. Debug keys: `W` wireframe,
  `P` particles, `N` normals, `Space` pause, `.` step, `[` / `]` slow-mo.
- Hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`.
- WebGL2 visual gaps: **`docs/WEBGL2.md`**. Telemetry: **`docs/TELEMETRY.md`**.
- Offline WGSL: `npm run check:wgsl` (naga). See **`docs/SHADERS.md`**.
- Query-param matrix: **`docs/AGENTS.md`**.

### C++ WASM physics path

Core: `cpp/src/sim_core.cpp`. Bridge: `src/wasm/seg-physics-bridge.js`.  
Enable: `?wasmPhysics=1` (or `?wasm=1`). Zero-copy views via `HEAPF32`.  
Docs: `cpp/README.md`, ADR-0002.

### Hardware digital twin (experimental)

- Bridge/UI: `hardware-bridge.js`, `hardware-panel.js` — **experimental**
- Demo without serial: `?mockHardware=1`
- Firmware under `firmware/seg-driver/` is **experimental**, not required for the app
- Spec: `docs/hardware_connection.md`

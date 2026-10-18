# AGENTS.md

**Full architecture map:** [`docs/AGENTS.md`](docs/AGENTS.md)  
**ADRs:** [`docs/adr/`](docs/adr/)  
**Short checklist:** [`CLAUDE.md`](CLAUDE.md)

This file adds **Cursor Cloud / headless VM** notes only.

## Cursor Cloud specific instructions

Single-product, client-side app (**SEG WebGPU Visualizer**), Vite `root: 'src/'`.
No backend, database, or server-side service.

### Services & commands

- **Dev server:** `npm run dev` → **`http://localhost:5173/`** (not HTTPS; Vite
  `server.https: false`). Serves `src/index.html`.
- **Build (Pages):** `npm run build:site`. Prebuilt WASM: `src/public/wasm/`.
- **Build (full):** `npm run build` (needs `emcc` or `EMSDK`).
- **Validate:** `npm run validate` → codegen/catalog checks + typecheck + native
  C++ + Node `test:*` suites (golden, snapshots, plant-worker, coupling,
  transports, …) + post/WGSL/bindings checks. Sanitizers: `npm run wasm:native:san`.
- **Plant snapshots:** `npm run test:snapshots` (native + shipped WASM + TS
  save → load → step bit-identical; needs `npm run wasm:native` first).
  Browser: `await window.lab.captureSnapshot()` / `window.lab.restoreSnapshot(s)`
  — **`docs/SNAPSHOTS.md`**.
- **E2E:** `npm run test:e2e` → Playwright + `?renderer=webgl2` (CI: `validate.yml`).
- **Typecheck:** `npm run typecheck` (`src/**/*.ts` + `generated/**/*.ts`).

### Browser testing caveat (important)

- This VM has **no GPU adapter** → default WebGPU boot **hard-fails** (no
  automatic WebGL2). Always use:
  **`http://localhost:5173/?renderer=webgl2`**
  Probe JSON: `window.webgpuProbe` (Chrome vs Edge guidance included).
- Operator flow: START → non-zero RPM/V/I/P (TelemetryHub), mode focus,
  SEG/Heron layouts, optional `?wasmPhysics=1`. Debug keys: `W` wireframe,
  `P` particles, `N` normals, `Space` pause, `.` step, `[` / `]` slow-mo.
- Hooks: `window.getRendererInfo()`, `window.captureCanvasFrame({ flipY: true })`.
- WebGL2 visual gaps: **`docs/WEBGL2.md`**. Telemetry: **`docs/TELEMETRY.md`**.
- Offline WGSL: `npm run check:wgsl` (naga). See **`docs/SHADERS.md`**.
- Embed: `?embed=1&embedOrigins=<origin>` (canvas + badge, postMessage
  protocol); parent demo at `/embed-demo.html`; teacher console `?teacher=1`.
  See **`docs/EMBED.md`**.
- Query-param matrix: **`docs/AGENTS.md`**.

### C++ WASM physics path

Core: `cpp/src/sim_core_*.cpp` + per-device plants in `cpp/src/plant/`. Bridge:
`src/wasm/seg-physics-bridge.ts`. Enable: `?wasmPhysics=1` (or `?wasm=1`).
Zero-copy views via `HEAPF32`. The interactive plant step runs in a Worker
(`src/workers/plant-worker.ts`); `?plantWorker=0` keeps it on the main thread.  
Docs: `cpp/README.md`, ADR-0002.

### Hardware digital twin (experimental)

- Bridge/UI: `hardware-bridge.ts`, `hardware-panel.ts` — **experimental**.
  Transports: Web Serial, BLE UART, WebUSB CDC (`src/*-transport.ts`)
- Demo without serial: `?mockHardware=1`
- Firmware under `firmware/seg-driver/` is **experimental**, not required for the app
- Spec: `docs/hardware_connection.md`

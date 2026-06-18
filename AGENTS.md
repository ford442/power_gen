# AGENTS.md

A detailed architecture/code guide lives in `docs/AGENTS.md`. This file adds
environment-specific notes for agents working in Cursor Cloud.

## Cursor Cloud specific instructions

This is a single-product, client-side web app (the **SEG WebGPU Visualizer**)
built with **Vite**. There is no backend, database, or server-side service.

### Services & commands

- **Dev server (only required service):** `npm run dev` serves the app at
  `http://localhost:5173/`. Vite's root is `src/`, so the dev server serves
  `src/index.html` (the dashboard / "old" architecture).
- **Build:** `npm run build:site` (plain `vite build`). Do NOT use `npm run build`
  for routine checks — it runs `wasm:build` first, whose script has hardcoded
  absolute paths (`/root/emsdk`, `/root/power_gen/cpp`) that do not exist here and
  will fail. Prebuilt WASM is already committed under `src/public/wasm/`, so it is
  not needed to run or build the site.
- **Lint / tests:** There is no `lint` or `test` npm script and no automated test
  suite. Type-checking via `npx tsc --noEmit` currently reports errors (missing
  `@webgpu/types`); it is pre-existing and not wired into any script, so do not
  treat it as a gating check.

### Browser testing caveat (important)

- This VM has **no GPU adapter**, so **WebGPU does not work** here. Loading the
  default `http://localhost:5173/` shows a "WebGPU init failed: No adapter" alert
  and renders a black canvas.
- For any browser-based testing, use the **WebGL2 fallback**:
  `http://localhost:5173/?renderer=webgl2`. This renders the live 3D scene
  (rollers, particles, grid) and supports the orbital camera (mouse drag) plus
  debug keys (`W` wireframe, `P` particle debug, `N` normals, `Space` pause,
  `.` step, `[` / `]` slow-mo).
- The WebGL2 path is a **visual-only fallback**. The dashboard's telemetry
  (RPM/Voltage/Current/Power), the `START`/`STOP` buttons, mode switching, and
  SEG layout switching are driven by the WebGPU visualizer and will **not** update
  under WebGL2 (values stay at 0). This is expected, not a bug.

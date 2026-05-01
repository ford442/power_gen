# Copilot Instructions

## Build, run, and validation commands

```bash
npm install
npm run dev
npm run build
npm run preview
npm run deploy
```

- `npm run dev` starts the Vite dev server on `https://localhost:5173`, using `src/` as the app root.
- `npm run build` builds the Vite app from `src/` into `dist/`.
- `npm run preview` previews that Vite build.
- `npm run deploy` runs the Vite build, then uploads `dist/` with `python deploy.py`.
- To exercise the GitHub Pages version locally, serve the repository root instead of `src/`:

```bash
npx serve . --ssl
```

- There is no automated test or lint script in `package.json`, and there is no single-test command in this repository. Validation is currently manual in a WebGPU-capable browser.

## MCP server guidance

- For browser automation, UI verification, or regression checks, the most relevant MCP server for this repository is **Playwright / browser automation**.
- Point Playwright at the correct surface:
  - use `npm run dev` for the Vite `src/` app
  - use `npx serve . --ssl` for the root app that GitHub Pages serves
- Playwright/browser MCP is most useful here for verifying WebGPU initialization, mode/view switching, device toggles, debug panel behavior, and the scientific panel overlays.

## High-level architecture

- This repository has **two active front-end surfaces**:
  1. **Root app (`index.html`, `main.js`, `multi-device-visualizer.js`, etc.)**: the modular multi-device visualizer used by the repository root.
  2. **Vite app under `src/` (`src/index.html`, `src/main.js`, `src/shaders/*.wgsl`)**: the older monolithic `SEGVisualizer` app that is used by `npm run dev`, `npm run build`, and `npm run preview`.
- **GitHub Pages deploys the repository root directly** via `.github/workflows/static.yml` with `path: '.'`. It does **not** build `dist/` first. Changes meant for the published Pages site usually belong in the root app, not only in `src/`.
- The root app is organized as:
  - `main.js` -> bootstraps `MultiDeviceVisualizer`
  - `multi-device-visualizer.js` -> orchestrates the render loop, camera/view switching, device setup, energy pipes, and global uniforms
  - `webgpu-manager.js` -> adapter/device/context/depth/global buffer setup
  - `device-instance.js` -> per-device state, compute uniforms, render branches
  - `device-geometry.js` -> device-specific buffers, particles, SEG geometry, field lines, energy arcs
  - `device-pipeline-manager.js` -> render/compute pipelines
  - `performance-profiler.js` + `debug-panel.js` -> profiling, GPU-tier tuning, debug UI
- `debug-panel.js` also exports `DEVICE_CONFIG`, which is the shared source of truth for device positions, colors, camera offsets, and particle counts in the root app.
- The `src/` app is a different stack: `src/main.js` owns WebGPU setup, render + compute pipelines, and UI wiring, while `src/integration.ts`, `src/ValidatedConstants.ts`, `src/fallback-physics.ts`, and related files provide the TypeScript physics/scientific layer.
- The root app still reuses `src/scientific-ui.js` and `src/scientific-ui.css` for the scientific panel, so root-level work can still require coordinated changes inside `src/`.

## Key repository conventions

- **Choose the target surface before editing.** `npm run dev/build/preview` only exercise the `src/` app, while GitHub Pages serves the root app. A change that only touches one surface may not affect the other.
- **Mode/device behavior is encoded in multiple places and must stay synchronized.**
  - In shaders and compute code, modes are numeric (`0=seg`, `1=heron`, `2=kelvin`, `3=solar`, and the root app also uses `4=peltier`).
  - In JavaScript, device-specific behavior is implemented with explicit `id === 'seg'` / `'solar'` / `'peltier'` branches.
  - When adding or changing a mode/device, update the JS mappings, uniform writes, shader logic, and any device configuration together.
- **WGSL shader edits usually belong in `src/shaders/*.wgsl` and are imported with `?raw`.** Keep shader uniform layouts aligned with the JS/TS buffers that write them.
- **The scientific/physics TypeScript layer is fallback-first at runtime.** `SEGIntegrationManager` currently disables live Wolfram MCP calls and uses prevalidated constants and fallback calculations instead. Preserve that behavior unless the task is explicitly about re-enabling live MCP.
- **Module imports use ES modules with explicit `.js` extensions** in the JavaScript codebase. Keep that import style for new root-level modules.
- **TypeScript is strict, but JavaScript is allowed.** `tsconfig.json` enables `strict` and `allowJs`, while `checkJs` is `false`, so TS files should stay strongly typed but plain JS files are not type-checked.

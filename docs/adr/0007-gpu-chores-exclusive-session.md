# ADR-0007: gpu-chores exclusive session (no third device)

- **Status:** Accepted
- **Date:** 2026-08

## Context

HUD / export meters (lab energy, flux, RMS) need generic `reduce_f32` / `map`.
Those used to live in ad-hoc JS next to each field shader, or tempted a
**second** graphics API (“WebGPU sim + WebGL HUD”). Dual-hot contexts double
VRAM and flake across Chromium builds.

The app already picks **one** session API at boot (`?renderer=webgpu|webgl2`).
`multi-device` means many simulated apparatuses on **one** `GPUDevice`.

## Decision

1. Boot still selects WebGPU **or** WebGL2 (`renderer-selector.js`). Never both
   owning the same field / particle buffers.
2. **gpu-chores** (`src/gpu-chores/`) is a meter backend, not a renderer:
   - WebGPU session → adopt `visualizer.device` (no `requestAdapter` /
     `requestDevice`).
   - WebGL2 session → WASM (`chores_reduce_f32_scratch`, via a HEAPF32 scratch) or JS goldens.
3. Domain shaders (`field-advect-compute.wgsl`, `particle-compute.wgsl`,
   Kelvin/SEG plants) stay owned by their devices.
4. Kill switch: `?gpuChores=0` (or `=js`) forces JS; `=wasm` skips GPU reduce.

5. **One live device, not one adapter forever.** After `device.lost`,
   `WebGPUManager.reinit()` requests a **fresh adapter** before
   `requestDevice`: the WebGPU spec *consumes* an adapter on its first
   successful `requestDevice`, so re-asking the old adapter always rejects
   (`OperationError`). The lost device is dead, so this never makes a second
   live device. A loss with `reason: 'destroyed'` comes from our own
   teardown and is not recovered (`window.simulateDeviceLost()` flags a test
   loss that is).

## Consequences

- HUD energy density / particle flux and CSV export RMS go through chores.
- Breadcrumbs: `getRendererInfo().chores` = `{ sessionApi, backend, adoptedDevice, killSwitch }`.
- Goldens: `npm run test:chores` + `sim_core_test --mode chores`.

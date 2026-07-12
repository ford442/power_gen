# ADR-0001: Dual renderer (WebGPU primary, WebGL2 fallback)

- **Status:** Accepted
- **Date:** 2026-07

## Context

The product targets cinematic multi-device visualization on WebGPU (compute particles, explicit bind groups, bloom). Many environments lack a usable WebGPU adapter: headless CI VMs, locked-down browsers, agent sandboxes without GPU.

## Decision

Ship **two** multi-device backends behind one bootstrap (`src/main.js` + `renderer-selector.js`):

1. **WebGPU** — `MultiDeviceVisualizer` (full fidelity).
2. **WebGL2** — `WebGL2MultiDeviceVisualizer` (shared CPU physics, intentional visual gaps).

Selection priority: `?renderer=` → `window.DEBUG_RENDERER` → `localStorage seg-renderer` → default WebGPU if `navigator.gpu`, else WebGL2.

Shared simulation and mesh primitives live in `src/renderers/shared/` so plant/telemetry stay aligned.

## Consequences

- **Positive:** Demo and operator UI work without WebGPU; agents can screenshot via WebGL2; physics iteration is not blocked on GPU drivers.
- **Negative:** Feature parity is incomplete (bloom, RK4 flux, energy-arc billboards, full PBR — see `docs/WEBGL2.md`). Two shader languages (WGSL + GLSL).
- **Neutral:** Telemetry is one hub; both paths call `publishFrame` after physics.

## Related

- `docs/WEBGL2.md`, `docs/WEBGPU.md`, `docs/AGENTS.md`

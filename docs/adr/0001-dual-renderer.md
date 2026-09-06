# ADR-0001: Dual renderer (WebGPU primary, WebGL2 opt-in)

- **Status:** Accepted (amended 2026-08 — auto-fallback disabled)
- **Date:** 2026-07

## Context

The product targets cinematic multi-device visualization on WebGPU (compute particles, explicit bind groups, bloom). Many environments lack a usable WebGPU adapter: headless CI VMs, locked-down browsers, agent sandboxes without GPU.

Automatic “WebGPU fail → WebGL2” rescue looked helpful but created dual-hot / dual-context pressure (VRAM, Chrome vs Edge flakes). gpu-chores (ADR-0007) forbids a third device and dual-live APIs.

## Decision

Ship **two GPU backends** behind one bootstrap (`src/main.ts` + `renderer-selector.js`) and **one LabSession** (ADR-0009):

1. **WebGPU** — `MultiDeviceVisualizer` (full fidelity) — **default required path**.
2. **WebGL2** — `WebGL2MultiDeviceVisualizer` — **explicit opt-in only** (`?renderer=webgl2`).

**Default boot:** WebGPU probe (`webgpu-probe.ts`) → success → WebGPU session; **failure → hard-fail UI, do not open WebGL2**.

Selection priority: `?renderer=` → `DEBUG_RENDERER` → default **webgpu**. Stored `localStorage` webgl2 is **not** applied as silent default.

Shared simulation and mesh primitives live in `src/renderers/shared/` so plant/telemetry stay aligned when WebGL2 is opted in.

## Consequences

- **Positive:** Single session API; clear Chrome vs Edge probe breadcrumbs (`window.webgpuProbe`); no dual-hot GL+GPU rescue.
- **Negative:** GPU-less agents must pass `?renderer=webgl2` explicitly; feature parity incomplete on that path (`docs/WEBGL2.md`).
- **Neutral:** Telemetry is one hub when either path runs; both call `publishFrame` after physics.

## Related

- ADR-0004, `docs/WEBGL2.md`, `docs/WEBGPU.md`, `docs/AGENTS.md`, ADR-0007, ADR-0009

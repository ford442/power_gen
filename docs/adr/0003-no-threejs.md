# ADR-0003: Custom WebGPU/WebGL2 stack (no Three.js)

- **Status:** Accepted
- **Date:** 2026-07

## Context

Three.js (and similar engines) speed up scene graphs but hide bind groups, limit offline WGSL validation, and make dual-backend parity harder. This lab needs explicit particle compute layouts, shared pipeline caches, and CI `naga` checks on extracted shaders.

## Decision

- **Do not** depend on Three.js, Babylon, or PlayCanvas.
- Own WebGPU via `WebGPUManager` + `PipelineLayoutCache` (explicit layouts, no production `layout: 'auto'`).
- Own WebGL2 via a thin multi-device renderer that reuses shared CPU physics.
- Author WGSL in `src/shaders/` with a small `#include` system; validate offline.

## Consequences

- **Positive:** Full control of instancing, bloom, flux tracers; CI can fail on hard WGSL errors; documentation of bindings is possible (`BINDINGS.md`).
- **Negative:** More code to maintain for cameras, materials, and loaders; glTF/CAD pipeline is a future epic, not free.
- **Neutral:** Educational clarity of the GPU path is a product goal.

## Related

- `docs/SHADERS.md`, `docs/BINDINGS.md`, ADR-0001

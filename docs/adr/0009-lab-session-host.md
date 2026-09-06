# ADR-0009: LabSession host (one plant, two GPU backends)

- **Status:** Accepted
- **Date:** 2026-09

## Context

WebGPU `MultiDeviceVisualizer` and WebGL2 `WebGL2MultiDeviceVisualizer` each
owned operator step, WASM plant apply, energy-network update, hardware-twin
sync, and `TelemetryHub.publishFrame`. A new WASM-backed device had to be
copied into both orchestrators. Mixins were `Object.assign`'d onto the WebGPU
class prototype.

ADR-0001 already requires two **GPU** backends behind one bootstrap, not two
lab hosts.

## Decision

Introduce **`LabSession`** (`src/session/lab-session.ts`) as the single plant /
mode / telemetry host. `src/main.ts` constructs one session, then either
backend:

```text
LabSession
  ├── MultiDeviceVisualizer   (WebGPU pipelines, post, glTF)
  └── WebGL2MultiDeviceVisualizer  (GLSL mesh / particles / lines)
```

- Backends consume `LabSession` + their GPU/GL device objects; they do not own
  operator, WASM apply, energy-network policy, or hub publish.
- WASM focus mapping lives in `src/session/apply-wasm-plant.ts` (one allowlist).
- WebGPU GPU helpers are named collaborators (`SharedGeometryFactory`,
  `PostStack`, `GltfPropRegistry`, …), not `Object.assign` on the public class.
- ADR-0001 (no silent WebGL2 rescue) and ADR-0007 (one GPU device; chores
  adopt it) are unchanged. Session never calls `requestAdapter` / `requestDevice`.

## Consequences

- **Positive:** One `setMode` / START / `#lab=` / `publishFrame` path; a 14th
  WASM device edits `apply-wasm-plant.ts` once.
- **Negative:** Device GPU instances stay backend-owned (`DeviceInstance` vs
  `WebGL2DeviceState`); session holds a plant view of the same object refs.
- **Neutral:** Public `window` APIs (`setMode`, `getRendererInfo`,
  `captureCanvasFrame`, `currentRenderer`, `segOperator`, `segWasm`,
  `multiVisualizer`) are unchanged.

## Related

- ADR-0001, ADR-0007, `docs/AGENTS.md`, `docs/WEBGL2.md`

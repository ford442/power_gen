# ADR-0004: Multi-device energy network (visual → physical)

- **Status:** Accepted — Phase A (power accounting) shipped; WASM coupling (Phase B) iterative
- **Date:** 2026-07 (updated 2026-07-18)

## Context

Overview mode places SEG, Heron, Kelvin, solar, Peltier, MHD (and plugins) in one scene. Operators need a readable sense of **energy transfer** between apparatuses. A fully conservative multi-physics network is research-scale work; shipping zero coupling left overview feeling disconnected.

## Decision

1. **Ship visual energy pipes** (`EnergyPipe`): Bézier particle streams between device anchors, driven by source `energyLevel` and enable flags — overview-only, quality-gated.
2. **Single telemetry path** (`TelemetryHub`) so gauges/operator do not invent a second energy story.
3. **Evolve toward physical coupling** (shared power budget, losses) without blocking visualization: keep pipe config declarative (`from` / `to` / `maxWatts` / `speed`); plant ODEs remain per-device (JS and/or WASM).
4. Do not claim the pipes are a validated conservation law — document honesty in AGENTS device table and overview disclaimer.

## Implementation phases

| Phase | Scope | Status |
|-------|--------|--------|
| **A — Power accounting** | `EnergyNetwork` in `renderers/shared/energy-network.ts`; sum device power; clamp pipe flow by source budget when coupling enabled; TelemetryHub `powerInW` / `powerOutW` / `efficiency`; UI toggle (visual-only vs coupled) | **Done** |
| **B — WASM coupling** | Optional bus state in `sim_core`; bridge `setNetworkEdges([...])` | Planned |
| **C — Conservation checks** | Dev overlay residual warning when ΣP ≠ 0 | Partial (debug panel shows residual W in coupled mode) |

### Phase A details

- **Default:** visual-only pipes (glow ∝ `energyLevel`, not watts).
- **Coupled mode:** `?energyCoupling=1` or debug-panel toggle / `localStorage seg-energy-coupling`.
- SEG source power uses `segOperator` / TelemetryHub `snap.seg.power` (W). Other devices use `energyLevel ×` nameplate estimate until calibrated.
- Pipe graph: `ENERGY_PIPE_EDGES` — shared by WebGPU and WebGL2.
- **Not metrology** without calibration — overview disclaimer + `docs/TELEMETRY.md`.

## Consequences

- **Positive:** Overview reads as a lab network; disabled devices damp pipes; coupled mode throttles glow when demand exceeds simulated source watts; LOD can thin pipe particles.
- **Negative:** Risk of users over-interpreting glow as measured watts; physical network needs careful units later.
- **Neutral:** WebGL2 uses simpler line strips — see `WEBGL2.md`.

## Related

- `src/renderers/shared/energy-network.ts`, `src/energy-pipe.js`, `docs/TELEMETRY.md`, ADR-0002

# ADR-0004: Multi-device energy network (visual → physical)

- **Status:** Accepted (visual); physical coupling iterative
- **Date:** 2026-07

## Context

Overview mode places SEG, Heron, Kelvin, solar, Peltier, MHD (and plugins) in one scene. Operators need a readable sense of **energy transfer** between apparatuses. A fully conservative multi-physics network is research-scale work; shipping zero coupling left overview feeling disconnected.

## Decision

1. **Ship visual energy pipes** (`EnergyPipe`): Bézier particle streams between device anchors, driven by source `energyLevel` and enable flags — overview-only, quality-gated.
2. **Single telemetry path** (`TelemetryHub`) so gauges/operator do not invent a second energy story.
3. **Evolve toward physical coupling** (shared power budget, losses) without blocking visualization: keep pipe config declarative (`from` / `to` / speed); plant ODEs remain per-device (JS and/or WASM).
4. Do not claim the pipes are a validated conservation law — document honesty in AGENTS device table.

## Consequences

- **Positive:** Overview reads as a lab network; disabled devices damp pipes; LOD can thin pipe particles.
- **Negative:** Risk of users over-interpreting glow as measured watts; physical network needs careful units later.
- **Neutral:** WebGL2 may use simpler line strips — see `WEBGL2.md`.

## Related

- `src/energy-pipe.js`, `docs/TELEMETRY.md`, ADR-0002

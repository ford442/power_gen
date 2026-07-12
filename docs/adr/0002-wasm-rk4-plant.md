# ADR-0002: Optional C++/WASM RK4 plant beside GPU particles

- **Status:** Accepted
- **Date:** 2026-07

## Context

Browser GPU particles are kinematic / visual (16-byte `GpuParticle`, WGSL compute). Research-facing plant dynamics (SEG roller ω, Heron head, Kelvin voltage, solar SOC) need stable, testable numerics and optional offline export. Implementing that only in JS risks drift and weak native testing.

## Decision

- Author a **C++17** core (`cpp/src/sim_core.*`) with RK4 (and mode plants), built to WASM via Emscripten; **prebuilt** artifacts committed under `src/public/wasm/`.
- Bridge from JS: `src/wasm/seg-physics-bridge.js` (+ typed helpers).
- **Opt-in at runtime:** `?wasmPhysics=1` / `?wasm=1` / debug panel / `localStorage useWasmPhysics`.
- Keep GPU particles on the interactive path; expose zero-copy `HEAPF32` views for tools/benchmarks. Document dual layouts: 16 B GPU vs 32 B `SimParticle` (`docs/SHADERS.md`).

## Consequences

- **Positive:** Native `g++` smoke tests without a browser; higher-fidelity plant when enabled; same UI works with pure JS plant when WASM is off.
- **Negative:** Dual particle layouts; full rebuild needs Emscripten; agents must not assume WASM is always on.
- **Neutral:** Routine site deploys use committed WASM (`npm run build:site`).

## Related

- `cpp/README.md`, `docs/AGENTS.md` (query matrix), ADR-0001

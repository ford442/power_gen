# ADR-0015: Plant snapshots from the device catalog

- **Status:** Accepted
- **Date:** 2026-10

## Context

Epic #224 asks for reproducible experiments: start from a saved operating
point, A/B two settings from the same instant, take a telemetry replay over and
run it live. All of these need the lab's simulated state as data, restored
**exactly** — a plant that resumes "close to" where it was is a different
experiment.

The state is spread over four places: 16 JS device plants (`physicsState`
objects), up to 13 C++ plants inside one or two `sim_core` instances (main
thread, or the plant worker), the SEG operator, and the session clock / seed.
JS and C++ name the same quantity differently (`vdgSparkAccum` vs
`_vdg.sparkAccum`), and a hand-written serializer per plant would drift from the
step code the moment someone adds an integrator.

## Decision

- **The catalog is the layout.** Each device in `physics/devices.json` carries a
  `state` block: the ordered fields its step reads before it writes, each with
  its `physicsState` key and C++ plant path. `codegen:catalog` validates it and
  emits the TS layout (`generated/device-state.ts`) and the C++ methods
  (`SEGSimulator::plantStateSize / plantSave / plantLoad`,
  `generated/plant-state-impl.h`). Nobody writes a serializer by hand.
- **Versioned by a layout hash, refused on mismatch.** `PLANT_STATE_LAYOUT_HASH`
  (FNV-1a of every `state` block) is baked into the binary; `plantLoad` refuses
  a vector written under another layout rather than misread it. Across builds a
  snapshot still restores its JS plants by key, and the C++ focus plant is
  cross-loaded from those keys.
- **Scratch ABI, no vectors across the boundary** — same as the energy bus.
- **Exactness is tested, not assumed.** `test:snapshots` requires a
  bit-identical save → load → step on every backend (native, shipped WASM, all
  16 TS plants, compared every frame) and holds the JS → C++ cross-load to the
  `test:golden` ε.
- **Lazy.** All browser glue (`window.lab.captureSnapshot` /
  `restoreSnapshot`, replay take-over) is a lazy chunk; the entry bundle only
  gains the stubs that load it.

## Consequences

- Adding plant state is a catalog edit; a field the step reads but the block
  misses fails `test:snapshots` as a divergence.
- Any layout change changes the hash, so an old snapshot's C++ vector is
  skipped (with a warning) on a new build — by design.
- GPU particles, camera and other visual-only state are not part of a snapshot;
  a restored lab looks right within a frame because they are derived.
- Simulated, not metrology: a snapshot is this model's state, not a recording
  of an instrument.

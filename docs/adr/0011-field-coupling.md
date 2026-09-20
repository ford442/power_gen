# ADR-0011: Lab field coupling (optional cross-device B)

- **Status:** Accepted
- **Date:** 2026-09

## Context

Fourteen devices share one lab, and several of them are about the *same* B.
`halbach-viz` computes a peak |B| from dipole superposition; `hall` derives its
own B from the shared drive control. `mhd` computes a channel field; the
`lorentz-sled` next to it takes B from a local panel slider. The two gallery
pages said so in as many words — "not live-coupled to `halbach-viz`" — which
was honest, and also the one obvious thing the lab did not do.

ADR-0004 already ships a lab **energy** bus on `?energyCoupling=1`. The
question was whether field coupling belongs on that switch or its own, and how
far the coupling should go.

Two constraints shaped the answer:

- **The sources are estimates, not measurements.** A Halbach peak from
  superposed dipoles and a drive-scaled MHD channel field are both lumped
  classroom numbers. Feeding one into another plant propagates a simulated
  estimate; it does not make either of them measured.
- **The isolated classroom is a legitimate default.** A bench whose B is a
  slider the student moves is a better first lesson than one whose B is
  inherited from a device two screens away.

## Decision

Ship an **optional** field bus, `FieldNetwork`
(`src/renderers/shared/field-network.ts`), on its **own** switch:
`?fieldCoupling=1`, `localStorage seg-field-coupling`, or the *Lab field
coupling* checkbox in the operator and debug panels.

1. **Off by default.** Every destination keeps the local B it has today:
   `hall` from the shared drive control, `lorentz-sled` from its panel slider.
   `lorentz-sled`'s slider value is parked in `lorentzFieldLocalT` while
   coupling is on and restored verbatim when it is switched off, so toggling
   the bus never loses a bench setting.
2. **A sibling flag, not `energyCoupling`.** One toggle meaning "the lab bus is
   live" would let a classroom that wanted coupled pipe *watts* silently also
   get a coupled *tesla*. The two buses assert different things about different
   quantities, so they get different switches — documented in the
   `docs/AGENTS.md` query matrix.
3. **Declarative edges, clamped.** `FIELD_COUPLING_EDGES` mirrors ADR-0004's
   `ENERGY_PIPE_EDGES`: destination `B = clamp(sourceEstimate, destination
   min/max)`, where the bounds are the destination's own catalog constants.
   A Halbach peak of 1.42 T clamps to the Hall bench's 0.65 T and the snapshot
   flags `clamped: true` rather than pretending the bench saw 1.42 T.

   | Edge | Source | Destination | Clamp |
   |------|--------|-------------|-------|
   | `halbach-viz` → `hall` | `halbachPeakBT` | `hallFieldCoupledT` → `hallFieldT` | 0 … `HALL.bMaxT` |
   | `mhd` → `lorentz-sled` | `mhdBFieldT` | `lorentzFieldT` | 0 … `LORENTZ.fieldTMax` |

4. **One setpoint, both plants.** `LabSession.stepPlant` runs
   `FieldNetwork.update()` *before* any plant steps, so the JS fallback and the
   C++ plant start the frame from the same B. `syncWasmFocusKnobs` pushes it
   over the bridge (`setHallFieldCoupledT`, the existing `setLorentzFieldT`);
   a negative T clears the coupling and returns the C++ plant to its local rule.
5. **Named in the UI.** Coupled destinations show the source device id and the
   words "simulated, not metrology"; the B slider becomes a read-only display
   rather than a control that silently does nothing. The overview line
   `#fieldCouplingDisclaimer` lists every live link and its value, in the same
   voice as the ADR-0004 pipe disclaimer.

## What this is not

Not Maxwell. There is no FEM, no FDTD, and no field solver in this decision —
the coupling copies one plant's scalar estimate into another plant's scalar
input and clamps it. The lab's only wave solver remains the pulse-coil FDTD
slice (ADR-0010), and it is not involved here.

Not metrology. Coupling two simulated estimates produces a third simulated
number. The Hall bench does not become a calibrated probe because its B now
comes from somewhere else.

**Kelvin ↔ VDG is deliberately out.** Both are electrostatic and share no B at
all; a charge/voltage bus between them is a different model with different
state, and belongs to a later epic rather than being wedged into a field bus.

## Goldens

`scripts/test-js-wasm-golden.mjs` covers the coupled path on both plants. The
native `--mode golden` run emits `hall-coupled` (B pinned to 0.31 T) and
`lorentz-sled-coupled` (0.45 T) beside the existing default cases, and the JS
fallback replays each schedule with the same setpoint seeded. Both setpoints
are chosen so a plant that *ignored* the coupling and kept using drive would
not accidentally agree: the default cases settle at 0.52 T and 0.80 T.

Golden case lines now carry `device=` and their knobs as `key=value` pairs, and
the Node side parses that tail generically — a future knob does not need a new
capture group.

## WASM artefact lag

`src/public/wasm/sim_core.wasm` is a CI artefact committed on main, so a branch
checkout can be running a binary older than `setHallFieldCoupledT`. The bridge
reports whether the loaded binary actually took the setpoint; when it did not,
`applyWasmPlant` leaves the Hall frame to the JS plant (which does honor it)
and warns once. Reporting a C++ drive-derived B under a panel that names a
coupled source would be a visible lie; falling back is not.

## Consequences

- **Positive:** The two "not live-coupled" caveats become a documented, opt-in
  feature rather than a gap. Both plants agree under coupling, proven by
  golden. Adding an edge is one row in `FIELD_COUPLING_EDGES`.
- **Negative:** A second coupling flag to explain, and a second place a user can
  over-read a simulated number as a measurement — mitigated by naming the
  source device everywhere the coupled value is shown.
- **Neutral:** The bus is CPU-side and per-frame; WGSL already reads B from
  per-device uniforms, so the coupled value reaches the shaders with no new
  pass.

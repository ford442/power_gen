# ADR-0021: Resolved thermal models — the Peltier leg

- **Status:** Accepted
- **Date:** 2026-11
- **Context issue:** fluids and heat epic, step 2

## Context

The `peltier` bench was two thermal nodes with a heater on one and the room on
the other: a thermoelectric *generator*, a few percent efficient, whose "COP"
readout was power out over heat in. Its name, its tour and the textbook
results people look for on a Peltier bench — `ΔT_max = Z·T_c²/2`, the optimum
current, the COP falling with current, reversing the current — are all about
the *cooler*. None of them could be shown, and a two-node model has no
profile for a thermal view to draw.

## Decision

1. **The bench is a current-driven cooler.** Drive sets the current magnitude
   (to 8 A, past the optimum on purpose); catalog setpoints set its direction
   and the heat load on the cold block.
2. **The leg is resolved in 1-D.** One equivalent leg for the whole module, 24
   finite-volume cells, plus four lumped end nodes (cold block, cold plate, hot
   plate, heat sink): 28 temperatures. Fourier conduction, Joule heat per cell,
   Peltier heat at the two junctions, an optional Thomson term for a
   temperature-dependent Seebeck coefficient (off by default so the
   constant-property textbook results hold exactly). The discrete scheme is
   written to conserve energy exactly: half-cell conductances at the plates,
   face temperatures for the Thomson term so it telescopes.
3. **It runs on `ros23`** through the shared integrator and the catalog `ode`
   block, like any other ported plant. The system is linear in T and stiff
   (10³ /s cell rates against 0.1 /s for the sink); an explicit method needs
   0.5 ms steps. The catalog `ode.state` grew one feature for it: a name may be
   an array field.
4. **State is a keyed array.** `peltierNodesK` is a `number[]` on
   `DevicePhysicsState` and a `float[28]` in C++, one catalog field with a
   `key` and a `count`. Snapshots save it element by element (`key[i]`), so the
   keyed values stay flat numbers and the JS ⇄ C++ cross-load carries it.
5. **`plantStateVersion`** (physics/devices.json, now 2) versions what the
   layout hash cannot: the *meaning* of saved values. `parsePlantSnapshot`
   migrates older keyed values forward (plant-snapshot-migrate.ts). Version 1
   Peltier snapshots keep their two plate temperatures; the leg is seeded with
   the straight line between them.
6. **C++ and a TS mirror**, held together by `test:golden` and by one set of
   textbook assertions run against native, the shipped WASM and TS
   (`test:peltier`).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep two nodes, change the equations to a cooler | Gives the lumped numbers but no profile to show, and nothing a thermal view could draw inside the module. |
| Implicit Euler + tridiagonal Thomas solve | Simpler and O(N), and it was the fallback had the shared integrators not landed. First order in time, and a second stepping scheme to keep in sync between C++ and TS. `ros23` is already there, tested, second order and L-stable; a dense 28×28 LU per step is microseconds. |
| 127 couples, p and n legs separately | 50× the state for the same lumped behaviour at these fidelity goals. |
| 28 scalar catalog fields | Works with no codegen change, and makes every table that lists state unreadable. |
| Temperature-dependent `S`, `R`, `K` from a datasheet | The textbook identities stop being exact, which is what the tests and the tour lean on. The Thomson slope is the one departure, behind a constant that is 0. |

## Consequences

- `peltierPowerW` is electrical input and `peltierCOP` the cooling COP: the
  same keys mean something else than they did. Two keys are new
  (`peltierQcW`, `peltierQhW`). Recorded runs from before the change are not
  comparable on this bench.
- The layout hash changed; `sim_core.wasm` is rebuilt.
- Porting this plant exposed a bug in the shared `ros23`: `lu_solve` /
  `luSolve` interleaved row interchanges with the forward substitution while
  the factorisation swapped whole rows, which is wrong as soon as a pivot is
  taken past column 0. Invisible to the 2- and 4-state plants (their
  `W = I − h·d·J` stays diagonally dominant); fixed in both languages, with a
  pivoting matrix and a stiff held-end chain added to `test:integrators`.
- The TS `OdePlant` gained an optional `jacobian` hook. Without it the 28-node
  leg spends 28 RHS calls per step on differences. C++ has the same hook
  (`sim_core::AnalyticJacobianPlant`) and the plant uses it: the dual-number
  Jacobian over 28 states cost 11.3 KB of the release binary.
- **`sim_core.wasm` is 189,952 B (was 163,244 B)**, +5.7 KB brotli: the shared
  integrators instantiated for 28 states, and the plant.
  `cpp/bench-baseline.json` is re-baselined with the breakdown. As first
  merged the binary was 201,274 B and over the 5 % gate, which CI did not
  report because an earlier step of the same job was already failing.
- **No explicit-integrator golden case.** `peltier@dopri5` was removed: on a
  stiff plant in float32 it compares rounding, and it failed on a compiler
  that contracts to FMA ([`INTEGRATORS.md`](../INTEGRATORS.md)).
- Explicit overrides (`euler`, `rk4`) on this plant substep at 0.5 ms. In
  float32 that accumulates ~20 mK of rounding over a few seconds, so they are
  a budget reference in `test:integrators`, not a golden case.
- Float32 temperatures bound how well a heat *balance* can be read back from
  the C++ plant: one ulp at 270 K through a 24 W/K junction is ~1 mW. The
  1e-3 energy-balance check carries a 5 mW floor on the single-precision
  backends for that reason.
- The IR view (a false-colour ramp on every bench from a per-device
  temperature) is a later step of the epic and will get its own ADR section
  here when it lands. Until then the three Peltier bodies carry a temperature
  colour of their own.

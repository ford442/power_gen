# ADR-0022: GPU liquid — an MLS-MPM solver in WebGPU compute

- **Status:** Accepted (solver core; no bench uses it yet)
- **Date:** 2026-11
- **Context issue:** fluids and heat epic, step 3

## Context

`heron` and `kelvin` draw water as closed-form droplet paths: each particle
is a function of time and its index, knows nothing of its neighbours, and
cannot pool, splash or fill anything. The epic asks for one liquid solver the
benches can share, in SI units, tied to their plants.

This ADR covers the solver core and how it is tested. Putting it on a bench —
boundaries from the props, emitters and sinks from the plant, a surface
instead of points — is the following steps.

## Decision

1. **MLS-MPM with APIC transfers**, quadratic B-spline weights, a weakly
   compressible liquid (Tait equation of state, no tension) and Newtonian
   viscosity. One substep is a grid clear and three compute passes:
   `mpm-p2g.wgsl` (particle → grid: mass, momentum and the stress impulse),
   `mpm-grid.wgsl` (momentum → velocity, gravity, walls), `mpm-g2p.wgsl`
   (grid → particle, advect).
2. **SI units inside the solver**: metres, seconds, kilograms, pascals,
   `g = 9.80665`. The domain is the box `[0, gridN·cellM]`; a bench places it
   in its scene with its own metres-per-scene-unit scale.
3. **Each particle carries its volume ratio `J = V/V₀`**, advanced from the
   divergence it sees (`J ← J·exp(dt·tr C)`); pressure is `B·(J^−γ − 1)`.
   Density is not gathered from neighbours. A gathered density reads low
   wherever the kernel is not full — at every free surface, and everywhere in
   a jet or droplet a couple of cells across — so those would feel no pressure
   until they had collapsed. The benches this is for are mostly jets and
   droplets. It also makes the stress part of the one scatter: three passes,
   not four.
4. **Fixed-point `atomic<i32>` grid.** P2G is a scatter and WGSL has no float
   atomics. Mass is accumulated in particle masses × `massScale`; momentum in
   particle mass × `maxSpeedMS` × `momentumScale`. Integer sums do not depend
   on the order the GPU runs the particles in, so the scatter is
   bit-deterministic.
   - **The scales come from the particle budget** (`mpmFixedScales`), sized so
     that every particle of the budget on one node still fits an i32. Overflow
     is excluded by arithmetic: no branch, no saturation, nothing to clamp.
     The cost is resolution that falls with the budget (momentum: 17 bits at
     15k particles, 16 at 40k, 14 at 120k).
   - **Contributions are rounded with a carried remainder.** A particle rounds
     its 27 contributions in sequence and passes the remainder on; each
     momentum channel starts from a hashed remainder in [−½, ½). Plain
     rounding has a dead zone — a particle slower than about
     `maxSpeedMS / momentumScale` rounds to nothing on every node and loses its
     momentum every step. Measured on the CPU reference: a settling column
     creeps, and still reads 3 % under hydrostatic after 800 substeps. With
     the carried remainder the same column matches the float-accumulated one
     (within 0.3 % of hydrostatic) and a particle's total is off by under one
     count.
   - The hash comes from a counter each particle carries (`seed`, a 32-bit
     PCG), so runs repeat and the CPU reference draws the same values.
5. **`maxSpeedMS` is a parameter**: grid velocities are clamped to it and the
   fixed-point momentum is scaled to it, so a bench that knows its liquid
   never passes 4 m/s gets finer momentum than one that allows a cell per
   substep.
6. **Walls are slip nodes** on the box: nothing flows into a wall, tangential
   motion is free. Boundaries from signed-distance fields and a body-force
   hook are added with the benches that need them.
7. **One layout, one bind group.** `mpm` has four bindings (params, particles,
   fixed-point grid, velocity grid); each pass declares the ones it uses.
   `MpmSolver` (`src/fluids/mpm-solver.ts`) owns the buffers and encodes
   substeps. Nothing is allocated until a bench creates one.
8. **A CPU twin for tests only.** `MpmCpu` steps the same buffers with the
   same fixed-point scatter. It is the reference the WGSL is held to on a
   real GPU (`test:gpu-golden`) and where the method is tested without one
   (`test:mpm`). It is not a fallback: WebGL2 has no liquid solver.
9. **Particle state is not plant state.** It is not in a snapshot and not on
   the telemetry hub; a restore re-seeds it. Emission is seeded and substeps
   are fixed, so the same inputs give the same picture.

## What the step size costs

The solver is explicit, so the speed of sound it can carry is set by the cell
and the step: `c ≤ 0.5·h/dt`. The liquid is as stiff as that allows and no
stiffer. For a 64³ grid over a 0.64 m box (`h` = 1 cm), four substeps a frame:

| Substep | Sound speed | A 10 cm pool compresses | A 30 cm column | A 2 m/s jet is at Mach | Shown at |
|---------|-------------|-------------------------|----------------|------------------------|----------|
| 1/240 s | 1.2 m/s | 28 % | 48 % | 1.7 | real time |
| 1/960 s | 4.8 m/s | 3.8 % | 9.6 % | 0.42 | ¼ speed |
| 1/2400 s | 12 m/s | 0.7 % | 1.9 % | 0.17 | 1/10 speed |
| 1/4800 s | 24 m/s | 0.2 % | 0.5 % | 0.08 | 1/20 speed |

The epic asks for a stiffness that keeps the step at 1/240 s on the default
grid. At bench scale that is the first row: not weakly compressible. Halving
the box makes it worse (`c` falls with `h`). The alternatives are more
substeps per frame, which the GPU budget does not have, or showing the liquid
slower than real time, as a high-speed camera would. **Which one a bench
takes is decided with that bench** (step 4 for Heron) and written in
`docs/FLUIDS.md` next to it; `mpmColumnCompression` gives the figure for any
choice.

## Alternatives considered

| Option | Why not |
|--------|---------|
| SPH / position-based fluids | Need a neighbour search (a sort or a hashed grid) every substep. MPM's background grid is the neighbour structure. |
| MPM with gathered density (one more pass) | Robust against drift in `J`, but pressure-less at free surfaces and in anything under ~2 cells across — see decision 3. Worth revisiting as a one-sided correction if long-lived pools clump. |
| Incompressible FLIP / APIC with a pressure projection | Removes the sound-speed limit and the table above with it. Needs a Poisson solve on the GPU every substep: a different order of work, and more than the frame budget at these sizes. |
| A saturating add (`atomicAdd`, undo if over a limit) | Keeps a fixed, finer scale for any budget, but the limit can be overshot by whatever is in flight between the add and the undo, so "cannot wrap" becomes "very unlikely". The budget-sized scale is a proof. |
| A compare-exchange loop per contribution | A real guarantee at a fixed scale, at the price of a loop around every one of 108 atomics per particle and of results that depend on contention. |
| Two i32 per channel (high and low halves) | 46 exact bits instead of 31, for 1.75× the atomics and grid memory. The upgrade path if the high tier's 14 bits prove too coarse. |
| Sort particles by cell and gather (no atomics) | Float accumulation, no scales at all — and a sort pass every substep. |
| Port to WebGL2 | No compute, no atomics. The fallback keeps honest ballistic particles and says the solver needs WebGPU. |

## Consequences

- **Numerical viscosity is about 2·10⁻³ m²/s** at `h` = 1 cm, `dt` = 0.5 ms on
  a vortex 13 cells across (`test:mpm` measures it) — some thousand times
  water's 10⁻⁶. The `viscosityPaS` uniform is exact on top of that (a vortex
  with μ = 10 Pa·s decays within 0.2 % of `2νk²` faster than one with none),
  but it only changes the picture for syrups. Water is drawn more viscous
  than it is.
- **No surface tension.** Droplets do not bead; a jet does not pinch off by
  itself.
- **`J` is integrated, never corrected** against where the particles actually
  are. The integration error is small per step, but nothing pulls it back; a
  particle that sits in a pool for minutes can drift. Benches recycle
  particles through sinks and emitters, which resets it.
- **Fixed-point noise makes free liquid swell slightly.** A block in free
  flight has no pressure to push back against expansion, so zero-mean noise
  in the velocity gradient ratchets `J` upward: 0.35 % in 400 substeps at the
  high tier's scales with `maxSpeedMS` = 8, 0.02 % at a 512-particle budget,
  none with float accumulation. Lower `maxSpeedMS` or a smaller budget
  shrinks it in proportion.
- **The ≤ 2 ms GPU target is not verified.** The tiers allocate and step on
  Dawn/Lavapipe, a CPU rasteriser: 4 substeps of the default tier take about
  65 ms there, which says nothing about an integrated GPU. It has to be
  measured with `?gpuTiming=1` on real hardware once a bench runs it.
- A new compute pass family: `mpm` in `bind-group-schema.json`,
  `ensureMpmPipelines`, `test:pipelines` compiles it for every colour mode.

## Tests

| Command | Holds |
|---------|-------|
| `npm run test:mpm` | scales cannot overflow for any budget; the worst-case fill on the CPU; uniform and particle layouts against the WGSL structs; mass exact and momentum conserved through the transfers; free fall at `g`; a column at ρ·g·h within 5 % at default- and high-tier scales; the viscous decay rate; walls; fixed point against float accumulation |
| `npm run test:gpu-golden` (`golden-mpm`) | the three WGSL passes on Dawn against `MpmCpu`: the grid after one substep to a few counts, 240 substeps of a dropped block to 2 % of a cell; momentum; a column at ρ·g·h within 5 %; the default budget on one node without a wrap; two runs byte-identical; each tier allocates and steps |
| `npm run test:pipelines` | the three pipelines compile on Tint + Dawn against the `mpm` layout |

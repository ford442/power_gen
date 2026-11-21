# ADR-0018: Circuit Lab — an MNA solver in sim_core, wired to bench ports

- **Status:** Accepted
- **Date:** 2026-11
- **Issue:** #256 (after #252, #253, #254; alongside #255, #257)

## Context

Every bench drove a fixed load: the transformer a 12 Ω resistor, the
homopolar disc its own brushes, the pulse coil its built-in bank and
auto-fire. A teacher could not hang a rectifier on the secondary, filter it
with an RC, or ring the pulse coil against a different capacitor. The energy
network's edges were estimates (catalog nameplates × activity), so its
residual measured the estimate, not conservation.

## Decision

1. **A small SPICE-like solver, C++ only, in sim_core** (`cpp/src/circuit/`).
   Modified Nodal Analysis with node 0 as ground. The elements are R, C, L
   (and K coupling), independent V / I (DC, SIN, PULSE), VCVS, VCCS, diode,
   ideal switch (with an optional clock), level-1 MOSFET, voltmeter and
   ammeter. Each concern has its own file:
   - **Integration** (`transient.cpp`). Trapezoidal companions. Backward
     Euler takes one short step at t = 0, after every breakpoint, after
     `setParam` toggles a switch, and after a diode or MOSFET changes
     region. Local error is checked against an AB2 predictor, with
     rejection, step growth hysteresis and step halving on Newton failure.
   - **Newton** (`newton.cpp`). Newton–Raphson with SPICE `pnjlim` on
     junctions and a step clamp on MOSFET gate/drain voltages.
   - **LU** (`lu.cpp`). Dense LU that reuses its symbolic analysis (pivot
     order and fill). It refactors on the recorded order with a 1e-3
     threshold-pivot check, and reuses the factors outright while the
     matrix is bit-identical. A linear circuit at a fixed host step factors
     once.
   - **Stamps** (`stamps.cpp`), and loading plus the readout
     (`circuit_sim.cpp`).

   No external libraries. The limits are 96 nodes and 256 elements; at that
   size, dense O(n³) is cheaper than sparse bookkeeping.
2. **No TS mirror.** The plants have TS twins because they are a few
   ODEs each. A Newton/LU solver in two languages would be two places for
   round-off to differ, with no golden to say which one is right. sim_core
   loads at boot on both renderers whatever `wasmPhysics` says
   (`wasmPhysics` picks the plant backend only). So the solver runs on
   WebGPU and on WebGL2, with the JS plant or the C++ one. When
   `sim_core.wasm` is not available, the host reports `needs-wasm`: the
   wiring view opens read-only, and the document still compiles, so links
   and `.cir` export work.
3. **Packed netlist over the ABI.** Netlists cross the ABI as packed f32s:
   `[FORMAT_VERSION, nodes, elems, nOpt, options…, per element: kind, nTerm,
   terminals…, nParam, params…]`. All arithmetic inside is double.
   - `cpp/abi.json` gains a `CircuitSim` class, plus `circuit_kind_name` and
     `circuit_format_version` so the TS kind table is checked against the
     binary. The class has load, step, setParam, readouts and stats.
   - The readout is one zero-copy f64 buffer. Its header holds time,
     status, steps, Newton iterations, rejections, W_source, W_dissipated,
     stored energy and stored-at-start. Then come node voltages, then, per
     element, i, v and p plus the window integrals ∫v·i, ∫i and ∫i².
4. **Catalog ports, one exchange per substep (ADR-0009).**
   - A bench the circuit can wire declares `ports` in `physics/devices.json`
     (id, label, terminals, driver, one-line `model`). Codegen checks that
     each `driver` is registered in `src/circuit/ports.ts`.
   - A driver expands into internal elements built from
     `physics/constants.json` values:
     - homopolar: V = k·ω, R and L;
     - transformer: the 60 Hz generator through R_p into L_p, K-coupled to
       L_s + R_s;
     - pulse coil: R and L.
   - Per plant substep, the host runs three phases:
     - `before` writes plant → circuit (EMF from ω, generator drive);
     - the solver advances dt;
     - `after` reads circuit → plant from the window integrals: the disc's
       torque k·ī with its own drive and drag, and the armature's ⟨i²⟩.
   - A wired bench is marked `_circuitOwned`: its JS plant skips it and its
     C++ focus result is ignored, so it is never stepped twice. A bench takes
     one PORT (validation refuses a second). If the solver stops mid-run,
     the host releases it and the bench goes back to its own physics.
   - Replay freezes the circuit. Leaving replay and an operator RESET
     restore its initial conditions.
5. **Energy books instead of estimates on the wired edges.** Per window:
   W_source − W_dissipated − ΔE_stored, with ΔE the true ½Cv² + ½Li² +
   M·i₁i₂ change. These are Tellegen's theorem on the discrete solution, so
   what is left is the trapezoid's O(h³). An exponential 1 s window gives
   the residual the energy network shows. Its disclaimer lists which edges
   are solved (Σ v·i) and which are still estimated. A port's edge is the
   power across its terminals: minus Σ v·i over the port's own elements, so
   a bench's winding losses are not counted as delivered. A 3-D cable from
   the bench to the circuit (EnergyPipe Bézier) flows ∝ the port's rms
   current.
   - A live edit to a C, L or k keeps each capacitor's voltage and each
     inductor's current, and re-derives charge and flux from them. Stored
     energy then describes the state the next step starts from, and the
     energy the edit adds or removes falls between two windows. (Keeping the
     charge instead booked about 900 % of the moved energy as residual after
     C was doubled mid-swing.)
6. **Floating common modes.** A bridge's floating source or secondary,
   with every diode off, is held only by junction conductance: a near-null
   direction (cond 1e10–1e14) where LU round-off makes Newton 2-cycle at the
   µV level, above vntol, forever. Two choices fix it:
   - every junction carries at least 1e-9 S (the node gmin stays 1e-12 S);
   - Newton also accepts an iterate once its update is within 100× tolerance
     **and** every KCL / branch row balances to 1e-13 of the sum of its own
     terms (`_balanced`).

   The currents that the jitter moves are 1e-14 A; only an ill-determined
   common-mode voltage jitters.
7. **Documents, UI, links.**
   - A netlist is a JSON `CircuitDoc` (`{ v: 1, e, w, n, scope, opt }`),
     validated and compiled in `src/circuit/netlist.ts`.
   - The LabConfig field `circuit` holds an example id or a whole document.
     `?circuit=` takes an id (or JSON); `#lab2=` and `.lab.json` carry the
     document.
   - The wiring view (`src/circuit-ui/`, lazy chunk) has: a palette with
     the catalog's port glyphs, drag and drop, click terminals to wire, SI
     inputs, and meters. The 2-channel scope sends to the analysis panel.
   - SPICE `.cir` export covers every kind. A port becomes a comment, and
     a switch becomes a resistor at its current state; a clocked switch
     exports open, with its clock in a comment. Import covers R L C V I D K,
     plus `.model D`.
8. **Experiments.**
   - `record` takes `circuit.node.<name>.v`, `circuit.elem.<id>.i|v|p`,
     `circuit.port.<id>.p` and `circuit.residual`.
   - `set` / `ramp` / `sweep` take `circuit.elem.<id>.<param>`, checked
     against the compiled netlist.
   - New: a `freq` stat (cycle frequency from peak spacing) and a `power`
     fit (log-log y = a·xᵇ).

## Testing

`npm run test:circuit` (in `test:unit`, so in `validate`):

- **Native goldens** (`sim_core_test --mode circuit`, also `make native`):
  - RC τ;
  - RLC f_d and Q, against the closed form and the trapezoid's own discrete
    answer;
  - half-wave ripple;
  - transformer ratio, against the phasor answer and the plant;
  - lossless-LC energy within 1e-4 over 1000+ periods at a 1/60 s host step;
  - switch flyback (BE restart, no ringing);
  - full-wave bridge (Newton converges every step, LU reused);
  - VCVS, VCCS, NMOS / PMOS.

  Every golden also closes its energy books to 1e-3.
- **WASM parity**: `--mode circuit-json` hands every golden's packed
  netlist, schedule and samples to the shipped binary. Its trajectory must
  match native to 1e-9 of each channel's scale. The LC-energy and RLC-Q
  claims are judged again on the WASM trace.
- **TS**: SI parsing, the compiler and key checks, rejected documents, the
  SPICE round-trip and import, the host (needs-wasm, books, solved edges,
  knobs, the teacher examples), LabConfig and `#lab2=` round-trips.
- **Reference experiments** (`test:experiments`, on the WASM solver for
  both backends):
  - `rectifier-ripple-vs-c`: ripple ∝ C^b, b within −1 ± 0.15;
  - `pulse-coil-rlc-resonance`: f ∝ C^b, b within −½ ± 0.03, and the
    fastest ring within 1 % of ½π·√(1/LC − (R/2L)²).

  Each also keeps the books' residual under 1 %.

## Consequences

- **Wired edges are measured, not estimated.** The energy network's
  residual on wired edges is a real conservation check; the other edges
  stay estimates and the disclaimer says which are which.
- **`sim_core.wasm` grows from 74 KB to 122 KB** (brotli 32 → 51 KB;
  122,380 B raw). The
  plants' throughput is unchanged. About 8.5 KB of the growth is musl
  `printf` for the error texts. `cpp/bench-baseline.json` is re-baselined
  with that note.
- **Fidelity stays uneven, and each port's `model` line says what is
  idealised.**
  - The homopolar disc is DC. A bridge on it shows almost no ripple, so the
    ripple experiment and the teacher's ripple example use the transformer.
  - The free-running homopolar plant's own load torque is I·B·r/2 (TS and
    C++). That is not consistent with its EMF ½·B·ω·r², which implies
    k·I = ½·B·r²·I. The port uses k for both directions, so its books close.
    The unwired plant is unchanged here and is left for a follow-up.
  - While wired, the pulse coil's peak-current latch is approximate: it
    takes the larger of the end-of-substep |i| and the substep's rms, not
    the true peak between samples.
- **Behaviour differs from the issue's wording on WebGL2.** With
  `wasmPhysics=0` the circuit still solves: what the issue called
  "needs WASM" is now "sim_core.wasm missing".

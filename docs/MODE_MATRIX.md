# Mode Contract Matrix

<!-- AUTO-GENERATED from physics/devices.json — do not edit the table by hand. -->
<!-- Regenerate: npm run codegen:catalog -->

Single source of truth: [`physics/devices.json`](../physics/devices.json).
Codegen emits TypeScript, C++ `enum SimMode`, WGSL `MODE_*` constants, and this table.

**`shaderMode` (JS/WGSL uniforms) and `wasmMode` / `SimMode` (C++) are two
intentional namespaces.** They agree for the six core devices and diverge after
that (e.g. `homopolar` shader **8** vs wasm **7**). Do not pass `shaderMode`
to `sim.setMode()`. The WASM bridge accepts a **device id string** and looks
up `wasmMode`; JS-only devices (`wasmMode: null`) do not call into C++.

Never reuse a retired `shaderMode`. New WASM plants take the next value in
`reservedWasmModes` (none), then bump that list — do not
invent a plant by silently reclaiming pulse-coil's shader slot 7.

## Matrix

| Device `id` | `shaderMode` (JS/WGSL) | `wasmMode` / `SimMode` | Telemetry keys (unit) | Fidelity |
|---|---|---|---|---|
| `seg` | 0 | 0 (`SIM_MODE_SEG`) | `rpm` (RPM), `omega` (rad/s), `corona` (%), `voltage` (V), `current` (A), `power` (W), `fieldSim` (T), `energyDensity` (J/m³) | WASM RK4 (full plant) |
| `heron` | 1 | 1 (`SIM_MODE_HERON`) | `heronHead` (m), `heronHeadMax` (m), `heronVExit` (m/s), `heronFlowRateLmin` (L/min), `heronPressureKPa` (kPa), `heronJetIdealM` (m), `heronJetHeightM` (m) | WASM (Bernoulli + Darcy–Weisbach); jet and pool: MLS-MPM liquid on WebGPU |
| `kelvin` | 2 | 2 (`SIM_MODE_KELVIN`) | `kelvinV` (V), `kelvinVoltageN` (%), `kelvinVbreak` (V), `kelvinE` (V/m), `kelvinSparkTimer` (s), `kelvinLandedShare` (%) | WASM (capacitive + spark); drops: SI, charged, in the rings' field (MLS-MPM on WebGPU, CPU on WebGL2) |
| `solar` | 3 | 3 (`SIM_MODE_SOLAR`) | `batteryCharge` (%) | WASM (battery SOC) |
| `peltier` | 4 | 4 (`SIM_MODE_PELTIER`) | `peltierHotK` (K), `peltierColdK` (K), `peltierDeltaT` (K), `peltierVoltage` (V), `peltierCurrent` (A), `peltierPowerW` (W), `peltierCOP`, `peltierQcW` (W), `peltierQhW` (W) | WASM (thermoelectric cooler: 1-D leg, 24 cells + 4 end nodes, ros23) |
| `mhd` | 5 | 5 (`SIM_MODE_MHD`) | `mhdFlowU` (m/s), `mhdBFieldT` (T), `mhdHartmann`, `mhdVoltage` (V), `mhdCurrent` (A), `mhdPowerW` (W) | WASM (mean flow: Hartmann wall friction + circuit braking, derived); profile: analytic Hartmann |
| `maglev` | 6 | 6 (`SIM_MODE_MAGLEV`) | `maglevGapMm` (mm), `maglevFieldT` (T), `maglevLiftN` (N), `maglevRpm` (RPM) | WASM (spring–damper gap ODE), JS fallback mirrors it |
| `pulse-coil` | 7 | none (`wasmMode: null`) | `pulseCoilCurrentA` (A), `pulseCoilVCap` (V), `pulseCoilBPeakT` (T), `pulseCoilArmatureMm` (mm) | JS-only (fallback-physics for pulseCoilBPeakT) |
| `homopolar` | 8 | 7 (`SIM_MODE_HOMOPOLAR`) | `homopolarRpm` (RPM), `homopolarEmfV` (V), `homopolarCurrentA` (A), `homopolarFieldT` (T) | WASM (Faraday disc L–R + back-EMF) |
| `halbach-viz` | 9 | none (`wasmMode: null`) | `halbachSegmentCount`, `halbachMagAngleDeg` (°), `halbachPeakBT` (T), `halbachPeriodM` (m), `halbachDipoleForceN` (N) | JS-only (CPU field-line viz); estimateHalbachFieldT is a free WASM helper, not a plant |
| `transformer` | 10 | 8 (`SIM_MODE_TRANSFORMER`) | `transformerVp` (V), `transformerVs` (V), `transformerIpA` (A), `transformerIsA` (A), `transformerK`, `transformerFluxN` (Wb) | WASM coupled-inductor RK4 ODE (?wasmPhysics=1); JS fallback mirrors it |
| `vdg` | 12 | 9 (`SIM_MODE_VDG`) | `vdgVoltage` (V), `vdgBeltMps` (m/s), `vdgChargeC` (C), `vdgSparkHz` (Hz) | WASM belt-charge/sphere-capacitance/spark-gap ODE (?wasmPhysics=1); JS fallback |
| `hall` | 13 | 10 (`SIM_MODE_HALL`) | `hallVoltage` (V), `hallCurrent` (A), `hallFieldT` (T), `hallCoeff` (m³/C) | WASM I·B→Hall-voltage ODE (?wasmPhysics=1); JS fallback |
| `lorentz-sled` | 14 | 11 (`SIM_MODE_LORENTZ_SLED`) | `lorentzSledVms` (m/s), `lorentzCurrentA` (A), `lorentzFieldT` (T), `lorentzForceN` (N), `lorentzPositionM` (m) | WASM R–L + back-EMF + Lorentz force ODE (?wasmPhysics=1); JS fallback mirrors it |
| `jumping-ring` | 15 | 12 (`SIM_MODE_JUMPING_RING`) | `ringHeightM` (m), `ringCurrentA` (A), `ringPrimaryIA` (A), `ringForceN` (N), `ringCouplingK` | WASM coupled L–M(h) ODE (adaptive Dormand–Prince 5(4)) with ring mass/gravity (?wasmPhysics=1); JS fallback mirrors it |
| `drop-tube` | 16 | none (`wasmMode: null`) | `dropTubeVMps` (m/s), `dropTubeTerminalVMps` (m/s), `dropTubeDragN` (N), `dropTubeEddyIA` (A), `dropTubeDepthM` (m) | JS-only algebraic eddy drag (point dipole, thin-walled tube): v_t = m·g/k, exact exponential step |

## Snapshot state

Each device's `state` block lists what a plant snapshot saves (see
[`SNAPSHOTS.md`](SNAPSHOTS.md)). The C++ vector is `[_time, _drive, …]`
followed by the block's `cpp` fields; layout hash
`0x16681daf` (`PLANT_STATE_LAYOUT_HASH`).

| Device `id` | TS keys | C++ `plantStateSize` | Keys shared with C++ |
|---|---|---|---|
| `seg` | 4 | 137 floats | 0 |
| `heron` | 7 | 8 floats | 5 |
| `kelvin` | 7 | 9 floats | 6 |
| `solar` | 2 | 4 floats | 1 |
| `peltier` | 42 | 44 floats | 41 |
| `mhd` | 7 | 9 floats | 6 |
| `maglev` | 7 | 9 floats | 6 |
| `pulse-coil` | 12 | — | — |
| `homopolar` | 10 | 11 floats | 8 |
| `halbach-viz` | 8 | — | — |
| `transformer` | 9 | 11 floats | 8 |
| `vdg` | 8 | 10 floats | 7 |
| `hall` | 7 | 9 floats | 6 |
| `lorentz-sled` | 7 | 8 floats | 5 |
| `jumping-ring` | 10 | 12 floats | 9 |
| `drop-tube` | 13 | — | — |

## Circuit Lab ports

A `ports` block lets the Circuit Lab (#256, [ADR-0018](adr/0018-circuit-lab.md),
[`CIRCUIT.md`](CIRCUIT.md)) wire a bench into a drawn circuit. The circuit is
solved by the C++ MNA solver in `sim_core.wasm` on **both renderers and
whatever `wasmPhysics` says** — `wasmPhysics` picks the plant backend, and
sim_core loads at boot either way. While a circuit owns a bench, that
bench's own plant (JS or C++) does not step it: its port driver does, with
the circuit, once per substep — from the plant's own equations where it has
mechanics (the disc's drive and drag), with the circuit's current in place
of the bench's fixed load. Other benches keep their backend.
Without `sim_core.wasm` the wiring view opens read-only with a
"needs WASM" note: there is no TS mirror of the solver.

| Device `id` | Port | Terminals (+ / −) | Driver | What the circuit sees |
|---|---|---|---|---|
| `pulse-coil` | `coil` (Coil) | coil + / coil − | `pulse-coil-coil` | The coil's R and L only — your capacitor and switch replace the bench's bank and auto-fire; the armature feels ⟨i²⟩ (pull ∝ I² proxy) |
| `homopolar` | `out` (Disc brushes) | rim + / axle − | `homopolar-emf` | EMF k·ω (k = ½ B r²) in series with the disc's own R and L; the circuit's current brakes the disc with torque k·ī |
| `transformer` | `sec` (Secondary winding) | s + / s − | `transformer-secondary` | The bench's 60 Hz generator (28 V pk × drive) through R_p into L_p, coupled (k, leakage toggle) to L_s + R_s; your circuit replaces the 12 Ω load |

## Liquid solvers

A `fluid` block puts a bench's liquid on the MLS-MPM solver
([ADR-0022](adr/0022-gpu-liquid-mls-mpm.md), [`FLUIDS.md`](FLUIDS.md)):
WebGPU only, and only while that bench is in focus — overview allocates
none of it. `fluid=auto|off|low|high` picks the tier; `auto` follows the
profiler and steps down, never back up. Budgets are a node budget (grid³,
shaped to the bench by its scene) and particle slots. The MHD duct's
lattice-Boltzmann slice is a solver of its own, with one size and no
particles, and is not in this table ([`FLUIDS.md`](FLUIDS.md#the-slice)).
Every other bench's "fluid" is a picture of its plant.

| Device `id` | Solver — what is simulated | Grid nodes / particles | Drawn as | WebGL2 instead | Idealised |
|---|---|---|---|---|---|
| `heron` | `mpm` — the jet above the nozzle, its cap and its fall to the tray | `low` 32³ / 15,000<br>`default` 64³ / 40,000<br>`high` 96³ / 120,000 | screen-space surface from the `medium` quality tier; particles below it, and for spray | ballistic droplets under SI gravity, each rising v²/2g | weakly compressible, shown at 1/6 speed; the tray drains instead of filling; no surface tension; the vessels' levels stay the plant's |
| `kelvin` | `mpm` — the two streams of charged drops between the drip tips and the collectors | 32³ / 2,048 at every tier | particles | the same drops on the CPU: gravity and q·E in 1 ms steps | one particle per Rayleigh–Plateau drop: no pinch-off, merging or drop–drop force; the conductors are rings of charge at the plant's potential; real time |

## How to add a device

1. Add a row to `physics/devices.json` (new unused `shaderMode`; `wasmMode` next reserved or `null`), including a `telemetry` entry (label / unit / digits) for every `telemetryKeys` entry, and a `state` block listing every field the plant's step reads before it writes.
2. Register a plugin that spreads `catalogIdentity('id')`.
3. Add a C++ plant + `case` **only if** `wasmMode` is set.
4. `npm run codegen:catalog` (and nameplates in `physics/constants.json` if the energy bus needs a watt rating), then `npm run test:snapshots`.

## Source of truth pointers

- Catalog JSON: `physics/devices.json`
- Generated: `generated/device-catalog.ts`, `generated/device-catalog.h`, `src/shaders/generated/device-catalog.wgsl`
- Registry: `src/devices/device-registry.ts` (`getDeviceModeIndex` = shader; `getDeviceWasmMode` = wasm)
- WASM bridge: `src/wasm/seg-physics-bridge.ts` `setMode(deviceId: string)` only
- Telemetry display + export schema: `DEVICE_TELEMETRY_FIELDS` / `TELEMETRY_CSV_DEVICE_COLUMNS` in `generated/device-catalog.ts` (see [`TELEMETRY.md`](TELEMETRY.md))

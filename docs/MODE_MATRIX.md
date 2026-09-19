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
| `heron` | 1 | 1 (`SIM_MODE_HERON`) | `heronHead` (m), `heronHeadMax` (m), `heronVExit` (m/s), `heronFlowRateLmin` (L/min), `heronPressureKPa` (kPa) | WASM (Bernoulli/Swamee–Jain) |
| `kelvin` | 2 | 2 (`SIM_MODE_KELVIN`) | `kelvinV` (V), `kelvinVoltageN` (%), `kelvinVbreak` (V), `kelvinE` (V/m), `kelvinSparkTimer` (s) | WASM (capacitive + spark) |
| `solar` | 3 | 3 (`SIM_MODE_SOLAR`) | `batteryCharge` (%) | WASM (battery SOC) |
| `peltier` | 4 | 4 (`SIM_MODE_PELTIER`) | `peltierHotK` (K), `peltierColdK` (K), `peltierDeltaT` (K), `peltierVoltage` (V), `peltierCurrent` (A), `peltierPowerW` (W), `peltierCOP` | WASM (two-node Seebeck/Peltier stack) |
| `mhd` | 5 | 5 (`SIM_MODE_MHD`) | `mhdFlowU` (m/s), `mhdBFieldT` (T), `mhdHartmann`, `mhdVoltage` (V), `mhdCurrent` (A), `mhdPowerW` (W) | WASM (Hartmann channel) |
| `maglev` | 6 | 6 (`SIM_MODE_MAGLEV`) | `maglevGapMm` (mm), `maglevFieldT` (T), `maglevLiftN` (N), `maglevRpm` (RPM) | WASM (spring–damper gap ODE), JS fallback mirrors it |
| `pulse-coil` | 7 | none (`wasmMode: null`) | `pulseCoilCurrentA` (A), `pulseCoilVCap` (V), `pulseCoilBPeakT` (T), `pulseCoilArmatureMm` (mm) | JS-only (fallback-physics for pulseCoilBPeakT) |
| `homopolar` | 8 | 7 (`SIM_MODE_HOMOPOLAR`) | `homopolarRpm` (RPM), `homopolarEmfV` (V), `homopolarCurrentA` (A), `homopolarFieldT` (T) | WASM (Faraday disc L–R + back-EMF) |
| `halbach-viz` | 9 | none (`wasmMode: null`) | `halbachSegmentCount`, `halbachMagAngleDeg` (°), `halbachPeakBT` (T), `halbachPeriodM` (m), `halbachDipoleForceN` (N) | JS-only (CPU field-line viz); estimateHalbachFieldT is a free WASM helper, not a plant |
| `transformer` | 10 | 8 (`SIM_MODE_TRANSFORMER`) | `transformerVp` (V), `transformerVs` (V), `transformerIpA` (A), `transformerIsA` (A), `transformerK`, `transformerFluxN` (Wb) | WASM coupled-inductor RK4 ODE (?wasmPhysics=1); JS fallback mirrors it |
| `vdg` | 12 | 9 (`SIM_MODE_VDG`) | `vdgVoltage` (V), `vdgBeltMps` (m/s), `vdgChargeC` (C), `vdgSparkHz` (Hz) | WASM belt-charge/sphere-capacitance/spark-gap ODE (?wasmPhysics=1); JS fallback |
| `hall` | 13 | 10 (`SIM_MODE_HALL`) | `hallVoltage` (V), `hallCurrent` (A), `hallFieldT` (T), `hallCoeff` (m³/C) | WASM I·B→Hall-voltage ODE (?wasmPhysics=1); JS fallback |
| `lorentz-sled` | 14 | 11 (`SIM_MODE_LORENTZ_SLED`) | `lorentzSledVms` (m/s), `lorentzCurrentA` (A), `lorentzFieldT` (T), `lorentzForceN` (N), `lorentzPositionM` (m) | WASM R–L + back-EMF + Lorentz force ODE (?wasmPhysics=1); JS fallback mirrors it |

## How to add a device

1. Add a row to `physics/devices.json` (new unused `shaderMode`; `wasmMode` next reserved or `null`), including a `telemetry` entry (label / unit / digits) for every `telemetryKeys` entry.
2. Register a plugin that spreads `catalogIdentity('id')`.
3. Add a C++ plant + `case` **only if** `wasmMode` is set.
4. `npm run codegen:catalog` (and nameplates in `physics/constants.json` if the energy bus needs a watt rating).

## Source of truth pointers

- Catalog JSON: `physics/devices.json`
- Generated: `generated/device-catalog.ts`, `generated/device-catalog.h`, `src/shaders/generated/device-catalog.wgsl`
- Registry: `src/devices/device-registry.ts` (`getDeviceModeIndex` = shader; `getDeviceWasmMode` = wasm)
- WASM bridge: `src/wasm/seg-physics-bridge.ts` `setMode(deviceId: string)` only
- Telemetry display + export schema: `DEVICE_TELEMETRY_FIELDS` / `TELEMETRY_CSV_DEVICE_COLUMNS` in `generated/device-catalog.ts` (see [`TELEMETRY.md`](TELEMETRY.md))

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
`reservedWasmModes` (), then bump that list — do not
invent a plant by silently reclaiming pulse-coil's shader slot 7.

## Matrix

| Device `id` | `shaderMode` (JS/WGSL) | `wasmMode` / `SimMode` | Telemetry keys | Fidelity |
|---|---|---|---|---|
| `seg` | 0 | 0 (`SIM_MODE_SEG`) | `rpm`, `omega`, `corona`, `voltage`, `current`, `power`, `fieldSim`, `energyDensity` | WASM RK4 (full plant) |
| `heron` | 1 | 1 (`SIM_MODE_HERON`) | `heronHead`, `heronVExit`, `heronFlowLmin`, `heronPressureKPa` | WASM (Bernoulli/Swamee–Jain) |
| `kelvin` | 2 | 2 (`SIM_MODE_KELVIN`) | `kelvinVoltage`, `kelvinVoltageN`, `kelvinE`, `kelvinSparkTimer` | WASM (capacitive + spark) |
| `solar` | 3 | 3 (`SIM_MODE_SOLAR`) | `solarBattery` | WASM (battery SOC) |
| `peltier` | 4 | 4 (`SIM_MODE_PELTIER`) | `peltierHotK`, `peltierColdK`, `peltierDeltaT`, `peltierVoltage`, `peltierCurrent`, `peltierPowerW`, `peltierCOP` | WASM (two-node Seebeck/Peltier stack) |
| `mhd` | 5 | 5 (`SIM_MODE_MHD`) | `mhdFlowU`, `mhdBFieldT`, `mhdHartmann`, `mhdVoltage`, `mhdCurrent`, `mhdPowerW` | WASM (Hartmann channel) |
| `maglev` | 6 | 6 (`SIM_MODE_MAGLEV`) | `maglevGapMm`, `maglevFieldT`, `maglevLiftN`, `maglevRpm` | WASM (spring–damper gap ODE), JS fallback mirrors it |
| `pulse-coil` | 7 | none (`wasmMode: null`) | `pulseCoilCurrentA`, `pulseCoilVCap`, `pulseCoilBPeakT`, `pulseCoilArmatureMm` | JS-only (fallback-physics for pulseCoilBPeakT) |
| `homopolar` | 8 | 7 (`SIM_MODE_HOMOPOLAR`) | `homopolarRpm`, `homopolarEmfV`, `homopolarCurrentA`, `homopolarFieldT` | WASM (Faraday disc L–R + back-EMF) |
| `halbach-viz` | 9 | none (`wasmMode: null`) | `halbachSegmentCount`, `halbachMagAngleDeg`, `halbachPeakBT`, `halbachPeriodM`, `halbachDipoleForceN` | JS-only (CPU field-line viz); estimateHalbachFieldT is a free WASM helper, not a plant |
| `transformer` | 10 | 8 (`SIM_MODE_TRANSFORMER`) | `transformerVp`, `transformerVs`, `transformerIpA`, `transformerIsA`, `transformerK`, `transformerFluxN` | WASM coupled-inductor ODE (?wasmPhysics=1); JS phasor fallback |
| `vdg` | 12 | 9 (`SIM_MODE_VDG`) | `vdgVoltage`, `vdgBeltMps`, `vdgChargeC`, `vdgSparkHz` | WASM belt-charge/sphere-capacitance/spark-gap ODE (?wasmPhysics=1); JS fallback |
| `hall` | 13 | 10 (`SIM_MODE_HALL`) | `hallVoltage`, `hallCurrent`, `hallFieldT`, `hallCoeff` | WASM I·B→Hall-voltage ODE (?wasmPhysics=1); JS fallback |
| `lorentz-sled` | 14 | 11 (`SIM_MODE_LORENTZ_SLED`) | `lorentzSledVms`, `lorentzCurrentA`, `lorentzFieldT`, `lorentzForceN`, `lorentzPositionM` | WASM R–L + back-EMF + Lorentz force ODE (?wasmPhysics=1); JS fallback mirrors it |

## How to add a device

1. Add a row to `physics/devices.json` (new unused `shaderMode`; `wasmMode` next reserved or `null`).
2. Register a plugin that spreads `catalogIdentity('id')`.
3. Add a C++ plant + `case` **only if** `wasmMode` is set.
4. `npm run codegen:catalog` (and nameplates in `physics/constants.json` if the energy bus needs a watt rating).

## Source of truth pointers

- Catalog JSON: `physics/devices.json`
- Generated: `generated/device-catalog.ts`, `generated/device-catalog.h`, `src/shaders/generated/device-catalog.wgsl`
- Registry: `src/devices/device-registry.ts` (`getDeviceModeIndex` = shader; `getDeviceWasmMode` = wasm)
- WASM bridge: `src/wasm/seg-physics-bridge.ts` `setMode(deviceId: string)` only

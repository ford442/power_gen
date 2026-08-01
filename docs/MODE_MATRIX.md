# Mode Contract Matrix

Single source of truth for how a device's identity maps across the three
places that currently know about "modes":

1. **JS device registry `modeIndex`** — written into device uniforms
   (`src/device-uniforms.js` → `getDeviceModeIndex()` in
   `src/devices/device-registry.js`) and consumed by the WGSL particle /
   physics shaders as a `u32` mode selector.
2. **C++ `SimMode` enum** (`cpp/src/sim_core.h`) — selects which plant
   `SEGSimulator::stepWithPerRingTorques()` advances, exposed to JS as
   `wasmMode` and reached at runtime via `segWasm.setMode()` in
   `src/wasm/seg-physics-bridge.js`, which maps a device *id string* (not
   `modeIndex`!) to the enum value through its own `MODE_MAP`.
3. **`docs/DEVICE_GALLERY.md`** — human-facing device catalog.

**`modeIndex` (JS/shader) and `wasmMode`/`SimMode` (C++) are two different
numbering spaces that happen to agree for the six "core" devices and
diverge for everything registered after them.** Nothing currently reads
`modeIndex` to decide the WASM `SimMode`, so today's divergence is not a
live bug in the data path — but it is exactly the kind of drift that
silently breaks the next feature that assumes the two are interchangeable.
Do not assume `modeIndex === wasmMode` without checking this table.

## Matrix

| Device `id` | `modeIndex` (JS/shader, `src/devices/**`) | `wasmMode` / `SimMode` (`cpp/src/sim_core.h`) | Telemetry keys | Fidelity tier |
|---|---|---|---|---|
| `seg` | 0 | 0 (`SIM_MODE_SEG`) | `rpm`, `omega`, `corona`, `voltage`, `current`, `power`, `fieldSim`, `energyDensity` (see `telemetry_export.h`) | WASM RK4 (full plant) |
| `heron` | 1 | 1 (`SIM_MODE_HERON`) | `heronHead`, `heronVExit`, `heronFlowLmin`, `heronPressureKPa` | WASM (Bernoulli/Swamee–Jain) |
| `kelvin` | 2 | 2 (`SIM_MODE_KELVIN`) | `kelvinVoltage`, `kelvinVoltageN`, `kelvinE`, `kelvinSparkTimer` | WASM (capacitive + spark) |
| `solar` | 3 | 3 (`SIM_MODE_SOLAR`) | `solarBattery` (SOC) | WASM (battery SOC) |
| `peltier` | 4 | 4 (`SIM_MODE_PELTIER`) | `peltierHotK`, `peltierColdK`, `peltierDeltaT`, `peltierVoltage`, `peltierCurrent`, `peltierPowerW`, `peltierCOP` | WASM (two-node Seebeck/Peltier stack) |
| `mhd` | 5 | 5 (`SIM_MODE_MHD`) | `mhdFlowU`, `mhdBFieldT`, `mhdHartmann`, `mhdVoltage`, `mhdCurrent`, `mhdPowerW` | WASM (Hartmann channel) |
| `maglev` | 6 | 6 (`SIM_MODE_MAGLEV`) | `maglevGapMm`, `maglevFieldT`, `maglevLiftN`, `maglevRpm` | WASM (spring–damper gap ODE), JS fallback mirrors it |
| `pulse-coil` | 7 | **none — WASM has no pulse-coil `SimMode`** (JS `modeIndex` 7 collides numerically with `SIM_MODE_HOMOPOLAR = 7`, but nothing maps `pulse-coil` through `segWasm.setMode()`, so there is no live conflict) | `pulseCoilCurrentA`, `pulseCoilVCap`, `pulseCoilBPeakT`, `pulseCoilArmatureMm` | JS-only (`fallback-physics` for `pulseCoilBPeakT`) |
| `homopolar` | **8** | **7** (`SIM_MODE_HOMOPOLAR`) — **known mismatch, see below** | `homopolarRpm`, `homopolarEmfV`, `homopolarCurrentA`, `homopolarFieldT` | WASM (Faraday disc L–R + back-EMF) |
| `halbach-viz` | 9 | none — WASM has no halbach-viz `SimMode`; `estimateHalbachFieldT()` is a free WASM helper function (not a plant mode) reused for offline field sampling | `halbachSegmentCount`, `halbachMagAngleDeg`, `halbachPeakBT`, `halbachDipoleForceN` | JS-only (CPU field-line viz); `halbachPeakBT`/`halbachDipoleForceN` sourced as `fallback-physics` |

## The homopolar 8 ↔ 7 mismatch — status: known bug, NOT fixed in this PR

- `src/devices/quanta/homopolar-generator.js` registers
  `modeIndex: 8` (the JS/shader mode-selector namespace).
- `cpp/src/sim_core.h` defines `SIM_MODE_HOMOPOLAR = 7` and
  `src/wasm/seg-physics-bridge.js`'s `MODE_MAP` correctly sends the WASM
  bridge `SimCore::setMode(7)` when asked for `'homopolar'` (it maps by
  device-id string, not by `modeIndex`), so **the live WASM physics path is
  not broken today**.
- The mismatch is that the *shader-facing* `modeIndex` (8) and the
  *WASM-facing* `SimMode` (7) disagree for the same logical device. Any
  future code that assumes `getDeviceModeIndex('homopolar') === wasmMode`
  (e.g. a generic "read modeIndex, pass straight to `SimCore.setMode()`"
  refactor) would silently step the wrong plant.
- Per the issue that spawned this task: **no silent renumbering of either
  side.** Fixing this properly requires touching, in the same change:
  `src/devices/quanta/homopolar-generator.js` (`modeIndex`), every WGSL
  shader branch keyed on that index, `src/wasm/seg-physics-bridge.js`'s
  `MODE_MAP` (if it is ever changed to derive from `modeIndex` instead of
  device id), and `docs/DEVICE_GALLERY.md`. That is out of scope here and
  is left as a follow-up.

## `pulse-coil` / `halbach-viz` — status: intentional JS-only reservation

Both devices are fully JS/CPU-side (`fallback-physics` particle + field
sampling, no `SimCore` plant). Their `modeIndex` values (7, 9) reserve slots
in the shader mode-selector space only; they do not correspond to — and are
not expected to correspond to — any `SimMode` enum value. `cpp/README.md`
already documents `estimateHalbachFieldT()` as a free helper kept in sync
with the JS Halbach estimate for `halbach-viz`, independent of the `SimMode`
plant list.

## Source of truth pointers

- JS/shader `modeIndex`: `src/devices/core/register-core.js`,
  `src/devices/quanta/*.js`, read via
  `src/devices/device-registry.js#getDeviceModeIndex`.
- WASM `SimMode` / `wasmMode`: `cpp/src/sim_core.h` (`enum SimMode`),
  `src/wasm/seg-physics-bridge.js` (`MODE_MAP`).
- Device catalog: `docs/DEVICE_GALLERY.md`.

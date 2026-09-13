# Telemetry architecture

## Single write path

```
segOperator.step()          ─┐
device physics (per id)      ─┼→ telemetryHub.publishFrame() → subscribers
scientific derived fields   ─┘
```

| Writer | Module |
|--------|--------|
| SEG plant (drive, ω, computeTelemetry) | `seg-operator-state.ts` |
| Multi-device frame publish | `multi-device-visualizer.ts` (WebGPU) |
| Multi-device frame publish | `renderers/webgl2/index.js` |
| Optional TS physics uniforms | `integration.ts` (syncs into hub scientific fields via multi-device) |

| Subscriber | Role |
|------------|------|
| `seg-operator-panel.ts` | Dashboard LED tiles, RPM gauge, footers |
| `scientific-ui/` `ScientificUIManager` | Floating physics gauges (optional) + generic catalog gauge strip |

**Do not** write RPM/voltage/current/power DOM from the visualizer. Publish to the hub instead.

## API

```js
import { telemetryHub, TelemetryHub } from './telemetry-hub.js';

// After physics each frame:
telemetryHub.publishFrame({
  dt,
  view: 'seg' | 'heron' | 'overview' | …,
  renderer: 'webgpu' | 'webgl2',
  devicePhysics: TelemetryHub.collectDevicePhysics(this.devices),
  scientific: { particleFlux, maxFieldMagnitude, avgEnergyDensity, … },
  // optional:
  energyNetwork: { couplingEnabled, labBudgetW, totalAllocatedW, residualW },
  hardwareTwin: {
    connected: true,
    mock: true,
    twinMode: 'shadow',
    sensorRpm, sensorPhase,
    shadowResidual: { phaseErrorDeg, rpmError }
  }
});

// UI:
const unsub = telemetryHub.subscribe((snap) => {
  // snap.seg — RPM, V, I, P, fieldSim, …
  // snap.devices.heron / kelvin / solar
  // snap.scientific
  // snap.meta — uncertainty for B_surface, energy density, torque
});
```

## Units and uncertainty

| Quantity | Unit | Meta |
|----------|------|------|
| B-field (display) | T | `snap.meta.B_surface` (ValidatedConstants / scientific-data) |
| Energy density | J/m³ in hub; scientific gauge shows kJ/m³ | `snap.meta.energyDensity_surface` |
| Torque | N·m | `snap.meta.torque_inner` |
| Particle flux | particles/s (proxy) | chores `reduce_f32` over device particle counts × speed |
| Lab energy sum / RMS | 0–1 scalars | chores reduce of per-device `energyLevel` (`snap.scientific.labEnergySum`) |
| Battery SOC | 0–1 in devices.solar | — |
| Lab bus `powerInW` / `powerOutW` | W (simulated) | `snap.devices[id]` via `EnergyNetwork` — **not metrology** |
| Lab bus efficiency | % | `snap.devices[id].efficiency` — SEG uses operator model when coupled |
| Energy network summary | W | `snap.energyNetwork` — budget, allocated, residual |
| Nameplate watts (non-SEG) | W | `physics/constants.json` → `energyNetwork.deviceNameplateWatts` — `simulatedOrderOfMagnitude: true` |

`SEG_SPEC` in `seg-operator-state.ts` is aligned with `ValidatedConstants` / `SEG_DATA`.

### Per-device catalog telemetry keys

Every non-SEG device publishes its catalog `telemetryKeys` as
`DeviceTelemetrySnap` fields on `snap.devices[id]`. Labels, units, precision and
CSV column names live with the key in
[`physics/devices.json`](../physics/devices.json) and are emitted into
`generated/device-catalog.ts` as `DEVICE_TELEMETRY_FIELDS`:

| Device | Keys (unit) | CSV columns |
|---|---|---|
| `heron` | `heronHead` (m), `heronHeadMax` (m), `heronVExit` (m/s), `heronFlowRateLmin` (L/min), `heronPressureKPa` (kPa) | `heron_head`, … |
| `kelvin` | `kelvinV` (V), `kelvinVoltageN` (%), `kelvinVbreak` (V), `kelvinE` (V/m), `kelvinSparkTimer` (s) | `kelvin_v`, … |
| `solar` | `batteryCharge` (%) | `battery_charge` |
| `peltier` | `peltierHotK` / `peltierColdK` / `peltierDeltaT` (K), `peltierVoltage` (V), `peltierCurrent` (A), `peltierPowerW` (W), `peltierCOP` | `peltier_hot_k`, … |
| `mhd` | `mhdFlowU` (m/s), `mhdBFieldT` (T), `mhdHartmann`, `mhdVoltage` (V), `mhdCurrent` (A), `mhdPowerW` (W) | `mhd_flow_u`, … |
| `maglev` | `maglevGapMm` (mm), `maglevFieldT` (T), `maglevLiftN` (N), `maglevRpm` (RPM) | `maglev_gap_mm`, … |
| `pulse-coil` | `pulseCoilCurrentA` (A), `pulseCoilVCap` (V), `pulseCoilBPeakT` (T), `pulseCoilArmatureMm` (mm) | `pulse_coil_current_a`, … |
| `homopolar` | `homopolarRpm` (RPM), `homopolarEmfV` (V), `homopolarCurrentA` (A), `homopolarFieldT` (T) | `homopolar_rpm`, … |
| `halbach-viz` | `halbachSegmentCount`, `halbachMagAngleDeg` (°), `halbachPeakBT` (T), `halbachPeriodM` (m), `halbachDipoleForceN` (N) | `halbach_segment_count`, … |
| `transformer` | `transformerVp` / `transformerVs` (V), `transformerIpA` / `transformerIsA` (A), `transformerK`, `transformerFluxN` (Wb) | `transformer_vp`, … |
| `vdg` | `vdgVoltage` (V), `vdgBeltMps` (m/s), `vdgChargeC` (C), `vdgSparkHz` (Hz) | `vdg_voltage`, … |
| `hall` | `hallVoltage` (V), `hallCurrent` (A), `hallFieldT` (T), `hallCoeff` (m³/C) | `hall_voltage`, … |
| `lorentz-sled` | `lorentzSledVms` (m/s), `lorentzCurrentA` (A), `lorentzFieldT` (T), `lorentzForceN` (N), `lorentzPositionM` (m) | `lorentz_sled_vms`, … |

`seg` is the one exception: its `telemetryKeys` (`rpm`, `omega`, `voltage`, …)
live on `SegOperatorTelemetry` (`snap.seg`), not on `snap.devices.seg` — the two
namespaces documented in [`MODE_MATRIX.md`](MODE_MATRIX.md), which carries the
full generated key/unit table.

**Honesty:** these are simulated plant values, exactly like energy-pipe watts and
nameplates (ADR-0004, [`DEVICE_GALLERY.md`](DEVICE_GALLERY.md)). Hall millivolts
and sled m/s are model output, not calibrated instrument readings — the
formatter attaches units, not a metrology claim.

#### Consumers

| Consumer | Module |
|---|---|
| Value formatting (units, SI prefixes, precision) | `src/telemetry/telemetry-fields.ts` — `formatTelemetryValue` |
| Focus footer + right-panel readout cells | `seg-operator-panel.ts` — one catalog-driven path, no per-device branch |
| Floating gauge strip | `scientific-ui/gauges/catalog-gauge-strip.ts` — one generic strip, not a gauge class per device |
| CSV / JSON export + replay | `src/telemetry/telemetry-schema.ts` — `TELEMETRY_CSV_DEVICE_COLUMNS`, `devicePhysicsFromRow` |

Adding a device to `physics/devices.json` (with its `telemetry` label/unit/digits
block) and running `npm run codegen:catalog` widens all four — `check:catalog`
fails if a key has no unit, if two keys collide on a CSV column, or if
`telemetry-schema.ts` stops deriving its columns from the catalog.

The existing SEG gauges (field, energy density, torque, particle flux) keep
owning SEG focus; the generic strip hides itself in SEG and overview.

### Residual definition

When coupling is enabled, the lab bus tracks:

- **labBudgetW** — sum of enabled devices’ simulated `powerOutW` (SEG from operator telemetry; others from `energyLevel × nameplate`).
- **totalAllocatedW** — sum of watts assigned to pipe edges after per-source budget clamping.
- **residualW** — `labBudgetW - totalAllocatedW` (unallocated source watts in the accounting model).

This is **not** a multi-physics energy conservation check (ΣP ≠ 0). Phase C may surface large residuals in a dev overlay.

### WASM bus path

With `?wasmPhysics=1` and `?energyCoupling=1`, `EnergyNetwork` delegates allocation to `sim_core` via `segWasm.updateEnergyNetwork()`. Pipe glow smoothing stays in JS; WebGPU and WebGL2 share the same clamp. Pure JS allocation remains the fallback when WASM is off.

## Energy pipes vs electrical telemetry

Overview **energy pipes** are a separate visual channel from SEG electrical output:

| Mode | Behavior |
|------|----------|
| **Visual only** (default) | Pipe glow ∝ source `energyLevel` (0–1). No watt clamping. |
| **Coupled** (`?energyCoupling=1` or debug panel) | Outgoing pipe demand is scaled so Σ allocated W ≤ source `powerOutW` per device. |

**Important:** Pipe intensity and `powerInW`/`powerOutW` on non-SEG devices use **simulated nameplate estimates** from `physics/constants.json` (`energyNetwork.deviceNameplateWatts`, flagged `simulatedOrderOfMagnitude`). Do not treat glow or bus fields as measured lab metrology. See ADR-0004 and the overview disclaimer (`#energyNetworkDisclaimer`).

In **coupled** overview mode, the disclaimer shows budget, allocated, residual W, and allocation efficiency. When `|residualW|` exceeds ~15% of budget (min 50 W), the banner turns warning-red — still simulated, not metrology.

```js
// Optional per-frame publish (WebGPU / WebGL2 render loops):
telemetryHub.publishFrame({
  …,
  energyNetwork: {
    couplingEnabled,
    labBudgetW,
    totalAllocatedW,
    residualW,
    devices: { seg: { powerInW, powerOutW, efficiency }, … }
  }
});
```

## Export & replay (P2)

Ring-buffer sampling lives on `telemetryHub.sampler` (1–60 Hz). UI: left sidebar **Telemetry Export**.

| Action | API |
|--------|-----|
| Record 10s sim time | `telemetryHub.startRecording(10, hz)` or **Record 10s** button |
| Download CSV | `window.exportTelemetryCsv()` — columns in `src/telemetry/telemetry-schema.ts`: the SEG/lab-bus base set (including optional `phase_error_deg`, `rpm_error`, `voltage_error_v`, `current_error_a`, `energy_residual_w`, `hw_connection_state`) followed by every catalog device column (`hall_voltage`, `lorentz_sled_vms`, …) |
| Config JSON | `window.exportConfigJson()` — constants + layout + operator setpoints |
| WASM offline 10s | **WASM 10s** — worker runs `SEGSimulator` headless, same CSV schema |
| Replay file | v1 JSON: seed, layout presets, speed curve + samples (`src/telemetry/replay-format.ts`). Samples are CSV v2 rows, so a replay round-trips plugin telemetry, not only SEG RPM |
| Replay scrubber | `?replay=1` or debug **Show replay scrubber** — drag-drop / file picker, play-pause-step. Parses in `src/workers/replay-worker.ts`. CSV load reconstructs a minimal replay. Live `publishFrame` and `segOperator.step()` are bypassed; gauges read injected hub snapshots. |
| Benchmark pack | `window.exportBenchmarkPack()` — profiler FPS/memory snapshot |
| Particle readback | `window.captureParticleSubset({ deviceId, maxCount })` (WebGPU, debug) |

`TELEMETRY_CSV_VERSION` is **2** — v2 appended the per-device catalog columns
after the base set. A v1 file still loads: `csvToRows` matches columns by name
and defaults the missing device columns to 0, so those devices simply replay
idle.

Native C++ export (same CSV header — `cpp/src/telemetry_export.h` builds it from
the base literal plus the generated `TELEMETRY_CSV_DEVICE_COLUMNS`, and the
SEG-only driver writes zeros for the columns it has no plant for):

```bash
cd cpp && make native   # smoke + writes build/seg_telemetry.csv
./build/sim_core_test --export-csv 10 output.csv 10
```

Deterministic particles: set **RNG seed** in export panel or `localStorage seg-sim-seed`.

### Replay playback

1. Record with **Record 10s**, then **Replay** to download `.seg-replay.json` (or **CSV**).
2. Open `?replay=1` (or the debug-panel button) and load the file — parse runs in a Web Worker.
3. Scrub / play / step. The header shows a **REPLAY** badge; `telemetryHub.getSnapshot().replay` is set; the sampler does not record replay frames. Device columns in the samples are fed back through `publishFrame({ devicePhysics })`, so `snap.devices.hall` / `vdg` / `lorentz-sled` restore alongside SEG.
4. **×** exits replay and live plant / telemetry resume.

```js
await window.loadReplayFile(file);          // JSON or CSV
window.replayPlayer.play();
window.replayPlayer.seek(2.5);
window.replayPlayer.exit();
```

## Scientific UI layout

All gauge widgets live under `src/scientific-ui/gauges/`. Import the panel and gauges from a single entry:

```js
import { ScientificUIManager, MagneticFieldGauge } from './scientific-ui/index.js';
```

`main.ts` lazy-loads `ScientificUIManager` (Ctrl+Shift+S toggle). Legacy root shims `scientific-ui.js` and `scientific-ui-utils.js` re-export the package for backward compatibility.

## Removed duplicates

- Floating **overlay** `ScientificUIManager` inside `integration.ts` — deleted (NoOp only).
- Visualizer direct DOM writes for battery/footer voltage — moved to operator panel via hub.
- Split gauge modules (`scientific-ui.js`, `scientific-ui-gauges.js`) — consolidated under `scientific-ui/`.

## WebGL2

WebGL2 steps `segOperator` and device physics, then `publishFrame`. With **START** pressed, RPM/V/I/P move the same as WebGPU.

# Telemetry architecture

## Single write path

```
segOperator.step()          ─┐
device physics (per id)      ─┼→ telemetryHub.publishFrame() → subscribers
scientific derived fields   ─┘
```

| Writer | Module |
|--------|--------|
| SEG plant (drive, ω, computeTelemetry) | `seg-operator-state.js` |
| Multi-device frame publish | `multi-device-visualizer.js` (WebGPU) |
| Multi-device frame publish | `renderers/webgl2/index.js` |
| Optional TS physics uniforms | `integration.ts` (syncs into hub scientific fields via multi-device) |

| Subscriber | Role |
|------------|------|
| `seg-operator-panel.js` | Dashboard LED tiles, RPM gauge, footers |
| `scientific-ui/` `ScientificUIManager` | Floating physics gauges (optional) |

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
  scientific: { particleFlux, maxFieldMagnitude, avgEnergyDensity, … }
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
| Particle flux | particles/s (proxy) | — |
| Battery SOC | 0–1 in devices.solar | — |

`SEG_SPEC` in `seg-operator-state.js` is aligned with `ValidatedConstants` / `SEG_DATA`.

## Export & replay (P2)

Ring-buffer sampling lives on `telemetryHub.sampler` (1–60 Hz). UI: left sidebar **Telemetry Export**.

| Action | API |
|--------|-----|
| Record 10s sim time | `telemetryHub.startRecording(10, hz)` or **Record 10s** button |
| Download CSV | `window.exportTelemetryCsv()` — columns in `src/telemetry/telemetry-schema.js` |
| Config JSON | `window.exportConfigJson()` — constants + layout + operator setpoints |
| WASM offline 10s | **WASM 10s** — worker runs `SEGSimulator` headless, same CSV schema |
| Replay file | v1 JSON: seed, layout presets, speed curve (`src/telemetry/replay-format.js`) |
| Benchmark pack | `window.exportBenchmarkPack()` — profiler FPS/memory snapshot |
| Particle readback | `window.captureParticleSubset({ deviceId, maxCount })` (WebGPU, debug) |

Native C++ export (same CSV header):

```bash
cd cpp && make native   # smoke + writes build/seg_telemetry.csv
./build/sim_core_test --export-csv 10 output.csv 10
```

Deterministic particles: set **RNG seed** in export panel or `localStorage seg-sim-seed`.

## Scientific UI layout

All gauge widgets live under `src/scientific-ui/gauges/`. Import the panel and gauges from a single entry:

```js
import { ScientificUIManager, MagneticFieldGauge } from './scientific-ui/index.js';
```

`main.js` lazy-loads `ScientificUIManager` (Ctrl+Shift+S toggle). Legacy root shims `scientific-ui.js` and `scientific-ui-utils.js` re-export the package for backward compatibility.

## Removed duplicates

- Floating **overlay** `ScientificUIManager` inside `integration.ts` — deleted (NoOp only).
- Visualizer direct DOM writes for battery/footer voltage — moved to operator panel via hub.
- Split gauge modules (`scientific-ui.js`, `scientific-ui-gauges.js`) — consolidated under `scientific-ui/`.

## WebGL2

WebGL2 steps `segOperator` and device physics, then `publishFrame`. With **START** pressed, RPM/V/I/P move the same as WebGPU.

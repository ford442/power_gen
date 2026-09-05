# Device Gallery

Catalog of multi-device lab apparatuses. Screenshots use the WebGL2 fallback
(`?renderer=webgl2`) for broad browser compatibility; capture via:

> **`shaderMode` vs `wasmMode`:** plugin `modeIndex` is the WGSL/uniform
> namespace (`shaderMode` in [`physics/devices.json`](../physics/devices.json)).
> It is **not** the C++ `SimMode`. See generated [`MODE_MATRIX.md`](./MODE_MATRIX.md).
> Homopolar shader **8** / wasm **7** is intentional. Add devices via the catalog
> first; do not invent a fourth magic number.

```js
// After START (non-zero drive) and a short settle:
window.setMode('maglev');
await window.captureCanvasFrame({ flipY: true });
// Save PNG under docs/images/<device>-focus.png (agent / CI path)
```

**Screenshot path convention:** `docs/images/<device-id>-focus.png` (and
optional `docs/images/<device-id>-overview.png`). Regenerated on Cloud VMs with
`?renderer=webgl2` because headless agents have no WebGPU adapter.

## Plugin registration

New devices register through `src/devices/device-registry.ts` without editing
`MultiDeviceVisualizer`:

```js
import { registerDevice } from '../device-registry';
import { catalogIdentity, NEXT_SHADER_MODE } from '../../generated/device-catalog';

registerDevice({
  ...catalogIdentity('my-device'), // after adding the row to physics/devices.json
  meshLayout: { cylinders: () => [...] },
  stepPhysics(state, dt, drive) { /* ... */ },
  createPhysicsState() { return { /* ... */ }; },
  telemetrySchema: { fieldT: { label: 'B-field', unit: 'T' } },
  references: [{ title: '...', authors: '...', year: 1980 }]
});
// Next unused shaderMode (do not reuse retired slots): NEXT_SHADER_MODE
```
```

Import side-effect bundle: `src/devices/register-plugins.js` (loaded from `main.ts`).

Overview positions for plugin devices without an explicit `position` are assigned
by `src/devices/layout-packer.ts` on an outer ring (radius 20 m).

---

## maglev

**Magnetic Levitation** — Quanta Magnetics research demo: Halbach-style ring
magnets lift a conductive floater; simplified spring–damper gap dynamics with
eddy-current damping metaphor.

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![MagLev focus](images/maglev-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('maglev')` → `captureCanvasFrame({ flipY: true })` → `docs/images/maglev-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Air gap | mm | Simulation (`maglevGapMm`) |
| B-field (est.) | T | `estimateHalbachFieldT()` — order-of-magnitude from B_r |
| Lift proxy | N | Spring lift model |
| Floater spin | RPM | Drive-scaled demo RPM |

### References

1. K. Halbach — *Design of permanent multipole magnets with oriented rare earth cobalt material* (1980)
2. M. V. Berry — *The levitation of spinning magnets* (1996)
3. `ValidatedConstants.MAGNET_BR` — NdFeB N52 remanence

### Implementation

- Plugin: `src/devices/quanta/magnetic-levitation.ts`
- WGSL mode index: `6` (`posMagLev` in `shaders/passes/particle-compute.wgsl`)
- WASM plant: `SimMode=6` (`?wasmPhysics=1`); JS spring–damper fallback when WASM off

---

## homopolar

**Homopolar Generator** — classic Faraday disc: rotating copper conductor in an
axial magnetic field with brushed radial current path. Educational L–R circuit
with back-EMF ε ≈ ½ B ω r² (not full 3D FEM).

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Homopolar focus](images/homopolar-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('homopolar')` → `captureCanvasFrame({ flipY: true })` → `docs/images/homopolar-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Disc RPM | RPM | Simulation (`homopolarRpm`) |
| EMF (est.) | V | `estimateHomopolarEmfV()` — ½ B ω r² |
| Disc current | A | L–R brushed circuit |
| B-field (axial) | T | NdFeB pole model (`homopolarFieldT`) |

### References

1. M. Faraday — *Experimental researches in electricity* (1831)
2. J. A. Wheeler, R. P. Feynman — *The homopolar generator* (1967)
3. H. D. Algie — *Unipolar machines: steady-state and transient analysis* (1989)

### Implementation

- Plugin: `src/devices/quanta/homopolar-generator.ts`
- WGSL mode index: `8` (`posHomopolar` in `shaders/passes/particle-compute.wgsl`)
- WebGL2: instanced disc + magnet poles via `mesh-renderer.drawPluginDevice`
- WASM plant: `SimMode=7` (`?wasmPhysics=1`); JS L–R fallback when WASM off

---

## halbach-viz

**Halbach Array Field Visualizer** — standalone Quanta demo showing how oriented
magnet segments shape the B-field. Configurable N-segment ring (or linear array
via `?halbachLinear=1`); speed slider drives segment count and magnetization
angle. CPU RK4 field-line tracer with |B| slice heatmap on focus view.

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Halbach focus](images/halbach-viz-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('halbach-viz')` → `captureCanvasFrame({ flipY: true })` → `docs/images/halbach-viz-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Segments | — | Simulation (`halbachSegmentCount`) |
| Mag. angle | ° | Per-segment rotation (`halbachMagAngleDeg`) |
| Peak \|B\| | T | Dipole superposition grid sample |
| Period | m | Spatial Halbach repeat (`halbachPeriodM`) |
| Dipole force | N | ∇(m·B) proxy on test dipole |

### References

1. K. Halbach — *Design of permanent multipole magnets with oriented rare earth cobalt material* (1980)
2. M. V. Berry — *The levitation of spinning magnets* (1996)
3. `src/physics/magnetic-field.ts` — shared dipole + Halbach superposition library

### Implementation

- Plugin: `src/devices/quanta/halbach-viz.ts`
- Field math: `src/physics/magnetic-field.ts`, `src/devices/quanta/halbach-field.ts`
- WGSL mode index: `9` (`posHalbach` in `shaders/passes/particle-compute.wgsl`)
- WebGL2: CPU field lines + heatmap via `renderers/webgl2/halbach-field-renderer.js`
- Shareable lab link: `#lab=…;mode=halbach-viz;hseg=12` (optional `hlin=1`)
- Plant: CPU-JS only (slow path OK); C++ exposes `estimateHalbachFieldT` for offline sampling

---

## pulse-coil

**Pulse Coil (R–L)** — classroom pulsed-electromagnet demo: capacitor-bank
discharge through a series inductor; peak B from coil amp-turns; soft-iron
armature travel as an attraction proxy. **Educational L–R model only** — not a
projectile, coilgun weapons, or high-energy pulse simulation.

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Pulse coil focus](images/pulse-coil-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('pulse-coil')` → `captureCanvasFrame({ flipY: true })` → `docs/images/pulse-coil-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Coil current | A | Series R–L discharge (`pulseCoilCurrentA`) |
| Cap voltage | V | Bank state (`pulseCoilVCap`) |
| B peak (est.) | T | μ₀ N I / (2 R) classroom estimate |
| Armature travel | mm | Soft-iron pull-in proxy (`pulseCoilArmatureMm`) |

### References

1. D. J. Griffiths — *Introduction to Electrodynamics* (series R–L)
2. E. M. Purcell, D. J. Morin — *Electricity and Magnetism* (RLC / amp-turns)
3. H. C. Roters — *Electromagnetic Devices* (solenoid armature fundamentals)

### Implementation

- Plugin: `src/devices/quanta/pulse-coil.ts`
- WGSL mode index: `7` (`posPulseCoil` in `shaders/passes/particle-compute.wgsl`)
- WebGL2: coil + cap bank + armature mesh via `drawPluginDevice`; basic particles
- Plant: **JS only by design** (no WASM `SimMode`; sandboxed educational model + footer I/V oscilloscope sparkline)
- Shareable lab link: `#lab=…;mode=pulse-coil;pcap=0.75` (optional charge fraction)

---

## transformer

**Mutual Induction** — Quanta classroom transformer: primary drive, secondary
resistive load, coupling coefficient *k*, and an ideal-vs-leakage toggle.
Textbook two-winding model (Chapman / Fitzgerald) — **not FEM**. JS path is
a phasor approx; `?wasmPhysics=1` runs the C++ coupled-inductor ODE.

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Transformer focus](images/transformer-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('transformer')` →
`setTransformerLeakage(false|true)` → `captureCanvasFrame({ flipY: true })` →
`docs/images/transformer-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Primary V | V | Plant (`transformerVp`) |
| Secondary V | V | Plant (`transformerVs`) |
| Primary I | A | Plant (`transformerIpA`) |
| Secondary I | A | Plant (`transformerIsA`) |
| Coupling *k* | — | Ideal ≈ 0.97 / leakage ≈ 0.72 |
| Flux (norm) | — | Visual flux bridge cue (`transformerFluxN`) |

### References

1. S. J. Chapman — *Electric Machinery Fundamentals* (ideal transformer & coupling)
2. A. E. Fitzgerald, C. Kingsley, S. D. Umans — *Electric Machinery* (coupled-circuit equations, M = k√(Lp Ls))

### Implementation

- Plugin: `src/devices/quanta/transformer.ts` (registered via `quanta/index.ts`)
- WGSL mode index: `10` (`posTransformer` in `shaders/passes/particle-compute.wgsl`)
- WASM `SimMode`: `8` (`SIM_MODE_TRANSFORMER` from `physics/devices.json`); plugin uses `catalogIdentity('transformer')`
- UI: Mutual Induction mode button; Ideal / Leakage coupling controls;
  `window.setTransformerLeakage(bool)`
- Plant: C++ coupled-inductor ODE when `?wasmPhysics=1`; JS phasor fallback
- Flux: WebGPU `passes/transformer-flux-compute.wgsl` (toroidal-core billboards
  in focus); WebGL2 keeps CPU flux particles

---

## vdg

**Van de Graaff Generator** — classroom electrostatic generator: an insulating
belt carries charge from a grounded lower comb to an upper comb near an
isolated metal sphere. Isolated-sphere capacitance `C = 4πε₀r`, a leakage
resistance, and a spark-gap discharge when the surface field exceeds the
classroom air-breakdown estimate (`E ≈ 3×10⁶ V/m`). **Educational model —
classroom electrostatics, not a high-voltage engineering design.**

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Van de Graaff focus](images/vdg-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('vdg')` → `captureCanvasFrame({ flipY: true })` → `docs/images/vdg-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Sphere voltage | V | Plant (`vdgVoltage`) |
| Belt speed | m/s | Drive-scaled belt speed (`vdgBeltMps`) |
| Sphere charge | C | Belt-charge minus leakage integral (`vdgChargeC`) |
| Spark rate | Hz | Rolling 1 s discharge-event window (`vdgSparkHz`) |

### References

1. R. J. Van de Graaff — *A 1,500,000 volt electrostatic generator* (1931)
2. D. J. Griffiths — *Introduction to Electrodynamics* (isolated-conductor capacitance, air-breakdown field)

### Implementation

- Plugin: `src/devices/quanta/van-de-graaff.ts` (registered via `quanta/index.ts`)
- WGSL mode index: `12` (`posVdg` in `shaders/passes/particle-compute.wgsl`)
- WASM `SimMode`: `9` (`SIM_MODE_VDG` from `physics/devices.json`); plugin uses `catalogIdentity('vdg')`
- UI: Van de Graaff mode button; `#lab=` guided tour (`window.startVdgTour()`)
- Plant: C++ belt-charge/leakage/spark-gap ODE when `?wasmPhysics=1`; JS fallback mirrors it exactly

---

## hall

**Hall-Effect Bench** — current-carrying conducting strip in a perpendicular
magnetic field: `V_H = I·B / (n·e·t)`, `R_H = 1/(n·e)`. A classroom toggle
switches carrier density between a semiconductor (~1e21 m⁻³, large Hall
voltage) and a metal (~1e28 m⁻³, Hall voltage nearly vanishes at the same
drive). **Educational model — not a calibrated metrology instrument.**

| View | Screenshot |
|------|------------|
| Overview | See [`images/multi-device.png`](images/multi-device.png) |
| Focus | ![Hall-effect bench focus](images/hall-focus.png) |

Capture: `?renderer=webgl2` → START → `setMode('hall')` →
`setHallCarrierType('semiconductor'|'metal')` → `captureCanvasFrame({ flipY: true })` →
`docs/images/hall-focus.png`.

### Telemetry

| Field | Unit | Source |
|-------|------|--------|
| Hall voltage | V | Plant (`hallVoltage`) |
| Drive current | A | Smoothed drive-scaled current (`hallCurrent`) |
| B-field | T | Local slider parameter (`hallFieldT`) |
| Hall coefficient | m³/C | `R_H = 1/(n·e)` for the selected carrier (`hallCoeff`) |

### References

1. E. H. Hall — *On a new action of the magnet on electric currents* (1879)
2. C. Kittel — *Introduction to Solid State Physics* (carrier density, Hall coefficient by material)

### Implementation

- Plugin: `src/devices/quanta/hall-effect.ts` (registered via `quanta/index.ts`)
- WGSL mode index: `13` (`posHall` in `shaders/passes/particle-compute.wgsl`)
- WASM `SimMode`: `10` (`SIM_MODE_HALL` from `physics/devices.json`); plugin uses `catalogIdentity('hall')`
- UI: Hall-Effect Bench mode button; Semiconductor / Metal carrier-density controls;
  `window.setHallCarrierType('semiconductor'|'metal')`
- Plant: C++ algebraic I·B→Hall-voltage model when `?wasmPhysics=1`; JS fallback mirrors it exactly
- B field is a local UI parameter here, not live-coupled to `halbach-viz`'s field estimate — the
  simpler of the two options the design allows, documented rather than treated as a cut corner

---

## Core secondary fidelity notes

| Device | Notes |
|--------|-------|
| `peltier` | Two-node ΔT / COP footer gauges; plate heat-map tint from plant; WASM fields mirrored in telemetry schema |
| `mhd` | Channel flow-arrow mesh; Hartmann readout; particle paths aligned with `flowU` / `bField` |

---

## Roadmap (candidate devices)

| Device | Status | Notes |
|--------|--------|-------|
| Magnetic bearing / levitation | **Live** (`maglev`) | WASM `SimMode=6` + JS fallback |
| Homopolar / Faraday disc | **Live** (`homopolar`) | WASM `SimMode=7` + JS fallback |
| Halbach array field visualizer | **Live** (`halbach-viz`) | Field line overlay + slice heatmap |
| Pulse magnet / coilgun (sandboxed) | **Live** (`pulse-coil`) | Educational R–L only; JS-only forever unless new SimMode reserved |
| Mutual induction / transformer | **Live** (`transformer`) | WASM L–M ODE (`SimMode=8`) + JS phasor fallback |
| Van de Graaff educational twin | **Live** (`vdg`) | WASM belt-charge/spark-gap ODE (`SimMode=9`) + JS fallback; pairs with Kelvin |
| Simple railgun / Lorentz sled | Candidate | Pairs with MHD |
| Hall-effect sensor bench | **Live** (`hall`) | WASM I·B→Hall-voltage model (`SimMode=10`) + JS fallback; pairs with homopolar/Halbach |
| Quanta product mockups | Blocked | Awaiting product specs |

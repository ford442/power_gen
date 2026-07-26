# Device Gallery

Catalog of multi-device lab apparatuses. Screenshots use the WebGL2 fallback
(`?renderer=webgl2`) for broad browser compatibility; capture via:

```js
window.setMode('maglev');
await window.captureCanvasFrame({ flipY: true });
```

## Plugin registration

New devices register through `src/devices/device-registry.js` without editing
`MultiDeviceVisualizer`:

```js
import { registerDevice } from '../device-registry.js';

registerDevice({
  id: 'my-device',
  label: 'My Apparatus',
  category: 'quanta',
  modeIndex: 7,
  meshLayout: { cylinders: () => [...] },
  stepPhysics(state, dt, drive) { /* ... */ },
  createPhysicsState() { return { /* ... */ }; },
  telemetrySchema: { fieldT: { label: 'B-field', unit: 'T' } },
  references: [{ title: '...', authors: '...', year: 1980 }]
});
```

Import side-effect bundle: `src/devices/register-plugins.js` (loaded from `main.js`).

Overview positions for plugin devices without an explicit `position` are assigned
by `src/devices/layout-packer.js` on an outer ring (radius 20 m).

---

## maglev

**Magnetic Levitation** — Quanta Magnetics research demo: Halbach-style ring
magnets lift a conductive floater; simplified spring–damper gap dynamics with
eddy-current damping metaphor.

| View | Screenshot |
|------|------------|
| Overview | *(placeholder — capture with `?renderer=webgl2` — `window.setMode('overview')`)* |
| Focus | *(placeholder — capture with `window.setMode('maglev')`)* |

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

- Plugin: `src/devices/quanta/magnetic-levitation.js`
- WGSL mode index: `6` (`posMagLev` in `shaders/passes/particle-compute.wgsl`)
- WASM plant: `SimMode=6` (`?wasmPhysics=1`); JS spring–damper fallback when WASM off

---

## homopolar

**Homopolar Generator** — classic Faraday disc: rotating copper conductor in an
axial magnetic field with brushed radial current path. Educational L–R circuit
with back-EMF ε ≈ ½ B ω r² (not full 3D FEM).

| View | Screenshot |
|------|------------|
| Overview | *(placeholder — capture with `?renderer=webgl2` — `window.setMode('overview')`)* |
| Focus | *(placeholder — capture with `window.setMode('homopolar')`)* |

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

- Plugin: `src/devices/quanta/homopolar-generator.js`
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
| Overview | *(placeholder — capture with `?renderer=webgl2` — `window.setMode('overview')`)* |
| Focus | *(placeholder — capture with `window.setMode('halbach-viz')`)* |

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

- Plugin: `src/devices/quanta/halbach-viz.js`
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
| Overview | *(placeholder — capture with `?renderer=webgl2` — `window.setMode('overview')`)* |
| Focus | *(placeholder — capture with `window.setMode('pulse-coil')`)* |

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

- Plugin: `src/devices/quanta/pulse-coil.js`
- WGSL mode index: `7` (`posPulseCoil` in `shaders/passes/particle-compute.wgsl`)
- WebGL2: coil + cap bank + armature mesh via `drawPluginDevice`; basic particles
- Plant: **JS only** (WASM plant not yet — sandboxed educational model)
- Shareable lab link: `#lab=…;mode=pulse-coil;pcap=0.75` (optional charge fraction)

---

## Roadmap (candidate devices)

| Device | Status | Notes |
|--------|--------|-------|
| Magnetic bearing / levitation | **Live** (`maglev`) | WASM `SimMode=6` + JS fallback |
| Homopolar / Faraday disc | **Live** (`homopolar`) | WASM `SimMode=7` + JS fallback |
| Halbach array field visualizer | **Live** (`halbach-viz`) | Field line overlay + slice heatmap |
| Pulse magnet / coilgun (sandboxed) | **Live** (`pulse-coil`) | Educational R–L only; classroom-safe copy |
| Quanta product mockups | Blocked | Awaiting product specs |

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
| Overview | *(capture with `?renderer=webgl2` — `window.setMode('overview')`)* |
| Focus | *(capture with `window.setMode('maglev')`)* |

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
- WGSL mode index: `6` (`posMagLev` in `shaders/generators/compute-shaders.js`)

---

## Roadmap (candidate devices)

| Device | Status | Notes |
|--------|--------|-------|
| Magnetic bearing / levitation | **Live** (`maglev`) | First Quanta catalog entry |
| Homopolar / Faraday disc | Planned | Rotating copper disc + axial B |
| Halbach array field visualizer | Planned | Field line overlay |
| Pulse magnet / coilgun (sandboxed) | Planned | Educational L–R model only |
| Quanta product mockups | Blocked | Awaiting product specs |

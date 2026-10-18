# SEG Explainer — tour, experiments, shareable lab links

Teaching layer on top of the multi-device dashboard: guided tour, synced 3D/2D
callouts, B-field experiments, and classroom mode.

## Guided tour

**UI:** Left sidebar → **SEG Learning** → **Guided Tour**

9-step script (`src/seg-explainer/seg-tour.json`):

1. Overview welcome  
2. SEG focus + central shaft  
3. Inner roller ring (NdFeB)  
4. Stator + ring separators  
5. Outer ring  
6. Pickup coils (C-cores)  
7. RK4 flux lines  
8. Ionization corona torus (starts plant)  
9. Layout comparison (Searl vs Roschin)

**API:** `window.startSEGTour()`

Tour drives:

- Camera keyframes (`MultiDeviceCamera.startCameraTransition`)
- `explainerState.highlightId` → 3D labels + 2D plan rings stay in sync
- Optional schematic overlay + annotations

## Device tours

Every bench except the SEG itself ships its own script alongside the SEG tour,
played by the same `SEGTourPlayer` from the **SEG Learning** sidebar. Every
script, its window hooks, its `#lab=` mapping and its sidebar button come from
the one registry `LAB_TOURS` in `seg-tour-player.ts` — adding a tour is one row
there (with a `label` for the button, which `explainer-ui.ts` generates into
`#explainerTourRow`) plus the JSON, not four edits:

| Tour | Script | Steps | API |
|------|--------|-------|-----|
| Van de Graaff | `src/seg-explainer/vdg-tour.json` | 5 | `window.startVdgTour()`, `window.goToVdgStep(id)` |
| Lorentz rail sled | `src/seg-explainer/lorentz-sled-tour.json` | 6 (current → field → force → motion, then what the model is not) | `window.startLorentzTour()`, `window.goToLorentzStep(id)` |
| Hall-effect bench | `src/seg-explainer/hall-tour.json` | 6 (I → B, local vs coupled → V_H = I·B/(n·e·t) → carrier density, then what the model is not) | `window.startHallTour()`, `window.goToHallStep(id)` |
| Mutual induction | `src/seg-explainer/transformer-tour.json` | 6 (I_p → core flux → turns ratio → coupling k and leakage, then what the model is not) | `window.startTransformerTour()`, `window.goToTransformerStep(id)` |
| Kelvin water dropper | `src/seg-explainer/kelvin-tour.json` | 6 (induction charging → positive feedback → what caps the climb → breakdown, then what the model is not) | `window.startKelvinTour()`, `window.goToKelvinStep(id)` |
| Heron's fountain | `src/seg-explainer/heron-tour.json` | 6 (driving head → Bernoulli exit speed → Swamee–Jain friction → build-shape presets, then what the model is not: no sealed-air volumes; the CAD vessels are `classic` only) | `window.startHeronTour()`, `window.goToHeronStep(id)` |
| Pulse coil | `src/seg-explainer/pulse-coil-tour.json` | 7 (charge and fire → L/R time constant → LC ring-down → the FDTD wave slice as a picture of dI/dt, not of the ODE → I² pull, then what the model is not) | `window.startPulseCoilTour()`, `window.goToPulseCoilStep(id)` |
| Homopolar generator | `src/seg-explainer/homopolar-tour.json` | 7 (fixed axial B → ε = ½Bωr² → brushed L–R loop → back-torque caps the speed → feeds Hall under field coupling, then what the model is not) | `window.startHomopolarTour()`, `window.goToHomopolarStep(id)` |
| Halbach array | `src/seg-explainer/halbach-viz-tour.json` | 7 (point-dipole segments → rotation step → one-sided field → how to read \|B\| and F → pairs with Hall under field coupling, then what the model is not) | `window.startHalbachTour()`, `window.goToHalbachStep(id)` |
| Thermoelectric stack | `src/seg-explainer/peltier-tour.json` | 6 (two thermal nodes → Seebeck voltage → Peltier heat feedback → what "COP" means here, then what the model is not) | `window.startPeltierTour()`, `window.goToPeltierStep(id)` |
| MHD channel | `src/seg-explainer/mhd-tour.json` | 7 (pump and field share one slider → Hartmann braking → Hartmann number → induced voltage → feeds the Lorentz sled under field coupling, then what the model is not) | `window.startMhdTour()`, `window.goToMhdStep(id)` |
| Magnetic levitation | `src/seg-explainer/maglev-tour.json` | 6 (target gap → spring sag → overdamped settling → what B, F and RPM mean, then what the model is not) | `window.startMaglevTour()`, `window.goToMaglevStep(id)` |
| Thomson jumping ring | `src/seg-explainer/jumping-ring-tour.json` | 7 (primary → induced current → force → why the lift decays → hover vs drive, then what the model is not) | `window.startJumpingRingTour()`, `window.goToJumpingRingStep(id)` |
| Lenz drop tube | `src/seg-explainer/drop-tube-tour.json` | 7 (release → every slice of wall is a ring → the currents push back → terminal velocity → change the tube's σ, then what the model is not) | `window.startDropTubeTour()`, `window.goToDropTubeStep(id)` |
| LED + solar loop | `src/seg-explainer/solar-tour.json` | 6 (LED power → efficiency chain → state of charge only falls → the I–V sketch, then what the model is not) | `window.startSolarTour()`, `window.goToSolarStep(id)` |

Every device tour ends on a **What this model is not** step, and every step
frames its bench with `cameraOffset` (relative to the device's laid-out origin),
never an absolute world position — the auto-layout ring moves benches. Tours
that mention a coupling bus (Halbach, homopolar, MHD) describe it as **off by
default**.

`#lab=…;tour=1` plays the tour that belongs to `mode` (`TOUR_BY_MODE`, derived
from `LAB_TOURS`), falling back to the SEG tour; `shareLabLink()` captures
whichever tour is actually running, so a link reopens on the same step of the
same tour.

### Step camera

A step frames its device with either key:

| Key | Meaning |
|-----|---------|
| `camera: { position, target }` | Absolute world keyframe — used by the older SEG-centric scripts written against fixed positions |
| `cameraOffset: [x, y, z]` (+ optional `cameraTargetY`) | Offset from the step's focused device origin — **preferred**, since most Quanta benches are placed by `applyAutoLayout` and have no stable absolute position |

## Shareable lab URL

Hash format:

```
#lab=v1;mode=seg;layout=searl;drive=0.50;field=0.50;bmult=2.00;class=1;tour=1;hi=coil;step=5
```

| Param | Meaning |
|-------|---------|
| `mode` | `seg`, `overview`, … |
| `layout` | `searl`, `roschin`, `legacy` |
| `drive` | Operator throttle 0–1 |
| `field` | Base excitation 0–1 |
| `bmult` | B-field experiment multiplier |
| `class` | `1` = classroom mode |
| `tour` | `1` = auto-start tour |
| `hi` | Annotation / highlight id (`coil`, `shaft`, `inner-ring`, …) |
| `step` | Tour step index (0-based) when `tour=1` |
| `lfield` | Lorentz rail sled bench field B, tesla (`mode=lorentz-sled`) |

**UI:** **Lab Link** copies URL to clipboard and updates `location.hash`.

**API:** `window.shareLabLink()`, `window.startSEGTour()`, `window.goToSEGStep('coil')`

## Experiments

- **B-field ×** slider (0.5–2×) scales `segOperator.magneticFieldStrength` — flux
  lines and corona respond on the next frame.
- **Searl / Roschin** quick layout compare buttons.

## Classroom mode

- Large annotation labels (hotspot dots when not highlighted)
- Dims non-essential sidebar sections  
- Enables annotations + plan view  
- Lower particle cap (via `explainerState.getParticleCapScale()`)
- Click hotspots or labels to jump to the matching tour step

## Accessibility

| Feature | Keys |
|---------|------|
| Camera orbit | Arrow keys (+ Shift = faster) |
| Zoom | `+` / `-` |
| 3D labels | `L` |
| Plan view | `D` |
| Pause / step (WebGL2) | `Space` / `.` / `[` `]` |
| Reduced motion | Checkbox or `prefers-reduced-motion` — caps particles, tour steps manual |

## Architecture

```
explainerState (highlight, classroom, bmult)
       ├→ seg-annotations.ts   (world-space labels + occlusion)
       ├→ seg-diagram-2d.ts    (ring highlight pulse)
       └→ seg-tour-player.ts   (camera + callouts)
```

Glossary terms: `src/seg-explainer/seg-glossary.ts` (from `scientific-data.ts`).

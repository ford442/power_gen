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
       ├→ seg-annotations.js   (world-space labels + occlusion)
       ├→ seg-diagram-2d.js    (ring highlight pulse)
       └→ seg-tour-player.js   (camera + callouts)
```

Glossary terms: `src/seg-explainer/seg-glossary.js` (from `scientific-data.js`).

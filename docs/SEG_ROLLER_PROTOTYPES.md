# SEG Roller Prototypes

This document describes the prototype-accurate SEG roller geometry and shading implemented in `generatePoleBandedRoller()` and the enhanced SEG fragment shader.

## Reference grounding

The roller redesign is grounded in documented SEG prototypes (rexresearch.com/searl4, Roschin–Godin reports):

- Real SEG rollers are **8 stacked segments** held together magnetically (~34 g each, machined to ±0.05 g). The visible barrel is the outer paramagnetic sleeve; the axial seams appear as fine machined grooves.
- The radial layer composition (visible on the flat roller ends) is, from the core outward:
  1. **Neodymium** — electron reservoir, silver-gray rare earth.
  2. **Nylon 66 / Teflon** — electron flow regulator, off-white/ivory dielectric.
  3. **Iron or Nickel** — magnetized accelerator stage.
  4. **Copper or Aluminum** — outer paramagnetic sleeve.
- The Roschin–Godin lab rollers used ceramic magnets sleeved in **aluminum cylinders**, showing light machining marks and galling/wear streaks.
- The official SEG Magnetics showroom mock-ups were nickel-plated, giving a bright chromed appearance rather than copper stripes.

## Geometry

`generatePoleBandedRoller()` in `src/seg-geometry-generators.js` now builds:

1. **Single top and bottom end-cap disks** — flat disks whose concentric rings are colored entirely in the fragment shader by radius.
2. **8 axial barrel segments** — the outer sleeve, separated by grooves.
3. **7 recessed groove rings** — actual geometry with inward-facing normals, sitting between the 8 barrel segments.

Default dimensions:
- `radius = 0.75`
- `height = 2.8`
- `bands = 8`
- `segments = 64`
- `grooveDepth = 0.035`
- `grooveWidth = 0.045`

Vertex UV convention:
- **End caps:** `uv.x = angle / 2π`, `uv.y = radial fraction` (0 at center, 1 at outer edge).
- **Barrel:** `uv.x = angle / 2π`, `uv.y = height fraction` (0 at bottom, 1 at top).
- **Grooves:** `uv.x = angle / 2π`, `uv.y = height fraction at groove center`.

## Shader logic

The enhanced SEG fragment shader (`segEnhancedFragShader` in `src/multi-device-shaders.js`) detects rollers by `renderMode == 0` and then distinguishes caps from the barrel by the normal (`abs(N.y) > 0.85`).

### End-face radial layers

The radial layer boundaries are (fraction of outer radius):

| Layer | Range | Material | Searl color | Lab color |
|-------|-------|----------|-------------|-----------|
| 0 | 0.00 – 0.30 | Neodymium core | `0.74, 0.76, 0.78` | `0.62, 0.64, 0.66` (ceramic) |
| 1 | 0.30 – 0.52 | Nylon / Teflon | `0.92, 0.90, 0.85` | `0.90, 0.88, 0.82` |
| 2 | 0.52 – 0.74 | Iron / Nickel | `0.88, 0.89, 0.91` | `0.55, 0.56, 0.58` |
| 3 | 0.74 – 1.00 | Copper / Aluminum outer | `0.85, 0.55, 0.28` | `0.78, 0.79, 0.80` |

At layer boundaries the normal is perturbed radially to simulate tiny machined steps.

### Barrel segments and grooves

The barrel is treated as the outer sleeve (layer 3). Grooves are detected in the shader by axial distance to a segment boundary:

```wgsl
let cyclePos = fract(yRel / segmentPitch) * segmentPitch;
let bandHeight = segmentPitch - ROLLER_GROOVE_WIDTH;
let distToBoundary = min(cyclePos, abs(cyclePos - bandHeight));
let isGroove = distToBoundary < ROLLER_GROOVE_WIDTH * 0.5 &&
               yRel > ROLLER_GROOVE_WIDTH && yRel < ROLLER_HEIGHT - ROLLER_GROOVE_WIDTH;
```

In a groove:
- Base color is darkened by 50% (oxidized/machined chamfer).
- Roughness is increased.
- The normal is bent inward to emphasize the recess.

### Emissive behavior

Emissive glow is now restricted to physically motivated regions:
- **Cap neodymium core** (`layerId == 0`): glows at high energy (`emissive = 0.22 * energy`).
- **Barrel grooves / seams**: glow at high energy (`emissive = 0.18 * energy`).
- The rest of the roller does not glow, fixing the previous "whole copper band emissive" look.

### Wear and oxidation

FBM noise is offset per layer and per segment so oxidation and machining marks do not smear across boundaries:

```wgsl
let layerOffset = vec3f(f32(layerId + 1) * 7.31, f32(segmentId + 1) * 11.73, 0.0);
let brushed = fbm(localPos * (mat.detailParams.x * 0.35) + layerOffset);
let oxidation = fbm(localPos * (mat.detailParams.x * 0.75 + 9.0) + layerOffset * 1.3);
```

### Material table override

For rollers the shader overrides the material-table lookup on caps so each radial layer uses an appropriate PBR preset:

| Layer | Material table index | Preset |
|-------|----------------------|--------|
| 0 | 4 | Neodymium |
| 1 | 3 | Insulation (nylon) |
| 2 | 1 | Steel |
| 3 (Searl) | 0 | Copper |
| 3 (Lab) | 10 | Anodized can / aluminum |

## Prototype preset toggle

Two presets are available:

- **`showroom`** (default) — Searl mock-up with bright nickel-plated accelerator stage and polished copper outer sleeve.
- **`lab`** — Roschin–Godin lab rig with aluminum sleeves, ceramic magnet core, and visible wear.

### Selecting a preset

The preset is read at init time from:

1. URL parameter: `?prototype=showroom` or `?prototype=lab`
2. Global JS override: `window.SEG_PROTOTYPE_PRESET = 'lab'` before the visualizer initializes.

Examples:

```
https://example.com/?prototype=lab
https://example.com/?prototype=showroom
```

```js
window.SEG_PROTOTYPE_PRESET = 'lab';
```

### CPU plumbing

- `src/multi-device-visualizer.js` reads the preset and stores it in `this.prototypePreset`.
- `src/device-uniforms.js` encodes the preset into the SEG `materialUniformBuffer` `pad1` slot:
  - `0.0` = showroom
  - `1.0` = lab
- `src/multi-device-shaders.js` reads `material.pad1` as `prototypePreset` and branches roller colors/materials accordingly.

## Files changed

- `src/seg-geometry-generators.js` — new `generatePoleBandedRoller()` with caps, 8 segments, and grooves.
- `src/multi-device-visualizer.js` — updated roller creation call; added `prototypePreset` parsing.
- `src/seg-enhanced-geometry.js` — updated default roller call to 8 bands / 64 segments.
- `src/multi-device-shaders.js` — `segEnhancedVertShader` and `segEnhancedFragShader` roller logic.
- `src/device-uniforms.js` — encode `prototypePreset` into SEG material uniform `pad1`.

## Synchronization note

If you change the roller geometry parameters (`ROLLER_RADIUS`, `ROLLER_HEIGHT`, `ROLLER_SEGMENTS`, `ROLLER_GROOVE_WIDTH`, `ROLLER_GROOVE_DEPTH`, or `LAYER_R*`), you must update both `generatePoleBandedRoller()` and the matching constants in `segEnhancedFragShader`. The shader constants are duplicated rather than passed as uniforms to keep the bind-group layout simple.

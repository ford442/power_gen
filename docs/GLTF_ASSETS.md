# glTF / GLB hybrid assets

The visualizer mixes **layout-driven procedural geometry** (rollers, rings, flux lines)
with **loaded glTF 2.0 meshes** (housing, lab shells, future Quanta product CAD).

## When glTF is used

| Path | Housing glTF |
|------|----------------|
| WebGPU (`MultiDeviceVisualizer`) | Yes — default on in **SEG focus** |
| WebGL2 fallback (`?renderer=webgl2`) | No — procedural `seg-frame-model` only |

Disable housing: `?gltfHousing=0`  
Force on: `?gltfHousing=1`

## Asset layout

```
src/public/assets/
  seg/
    housing-shell.glb   # generated showroom shell
    LICENSE.md
```

Regenerate the placeholder housing:

```bash
npm run generate:housing-glb
```

## Authoring workflow (Blender → glTF)

1. Model in **metres** with origin at the SEG assembly centre (Y up).
2. Export **glTF 2.0 Binary (.glb)** with:
   - Triangulated meshes
   - Applied transforms
   - `POSITION`, `NORMAL`, `TEXCOORD_0` (optional UVs)
3. Add custom root-node extras for anchors and material hints:

```json
{
  "extras": {
    "power_gen": {
      "materialRingIndex": 11.0,
      "anchors": [
        { "name": "assembly_origin", "position": [0, 0, 0] },
        { "name": "telemetry_mount", "position": [0, 1.1, 5.2] }
      ]
    }
  }
}
```

4. Drop the file under `src/public/assets/seg/` (or add a new registry entry).
5. `materialRingIndex` maps to the seg-enhanced PBR table (`ringIndex` in the instance buffer):
   - `11.0` — structural aluminum (default housing)
   - `13.0` — dark lab base
   - See `sharedMaterialId()` in `seg-enhanced-shaders.js`

## Runtime pipeline

```
physics/constants.json     seg-layout.js PRESET_DEFS
        │                          │
        ▼                          ▼
 procedural rollers/rings    layout worldScale + frameDims
        │                          │
        └──────────┬─────────────────┘
                   ▼
         assets/gltf/gltf-loader.js  →  scene graph  →  WebGPU buffers
                   │
                   ▼
    seg-enhanced PBR pipeline (same as enhanced SEG meshes)
```

- **Loader:** `src/assets/gltf/gltf-loader.js` — hand-rolled GLB v2 (no `@loaders.gl` dependency;
  keeps Pages bundle small and matches ADR-0003 no-Three.js stance).
- **Scene graph:** `gltf-scene.js` — hierarchy, visibility, anchor baking from `extras.power_gen`.
- **GPU upload:** `gltf-gpu.js` — 8-float vertices (pos+normal+uv), 48-byte instances.
- **Setup:** `visualizer/setup-gltf.js` — loads housing after procedural core meshes.
- **Draw:** `DeviceRenderMixin.renderGltfHousing` — SEG focus only; procedural rollers unchanged.

## Sim-driven material overrides

Housing emissive trim follows `segOmega` (RPM proxy) via the instance `greenEmissive` channel,
updated each frame in `updateGltfHousingState()`.

## Collision / annotation anchors

Anchors baked at load time are exposed on the visualizer as `gltfHousingAnchors` (world space,
layout-scaled). Future work: wire `seg-annotations.js` to these points.

## Bundle size notes

- Placeholder `housing-shell.glb` is a few KB (procedural boxes).
- Prefer **Draco-free** glTF for the minimal loader; add meshopt/Draco only after evaluating
  decode cost on GitHub Pages.
- Large CAD assets should be lazy-loaded per device focus, not in the main chunk.

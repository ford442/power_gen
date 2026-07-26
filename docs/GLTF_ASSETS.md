# glTF / GLB hybrid assets

The visualizer mixes **layout-driven procedural geometry** (rollers, rings, flux lines)
with **loaded glTF 2.0 meshes** (housing, coil former, future Quanta product CAD).

Formal scene graph: `src/assets/scene/scene-node.js` (`SceneNode`) — ADR-0005.
glTF trees are built via `buildGltfScene()` → `GltfSceneNode extends SceneNode`.

## When glTF is used

| Path | Housing / coil former glTF |
|------|----------------------------|
| WebGPU (`MultiDeviceVisualizer`) | Yes — default on in **SEG focus** |
| WebGL2 fallback (`?renderer=webgl2`) | No — procedural `seg-frame-model` only |

Disable all CAD props: `?gltfHousing=0`  
Disable coil former only: `?gltfCoilFormer=0`  
Force housing on: `?gltfHousing=1`

## Asset layout

```
src/public/assets/
  seg/
    housing-shell.glb   # generated showroom shell
    coil-former.glb     # generated coil bobbin / former (second CAD prop)
    LICENSE.md
```

Regenerate placeholders:

```bash
npm run generate:housing-glb
npm run generate:coil-former-glb
# or both:
npm run generate:seg-gltf
```

## Authoring workflow (Blender → glTF)

1. Model in **metres** with origin at the SEG assembly centre (Y up).
2. Export **glTF 2.0 Binary (.glb)** with:
   - Triangulated meshes
   - Applied transforms
   - `POSITION`, `NORMAL`, `TEXCOORD_0` (optional UVs)
3. Add custom root-node extras for anchors, material hints, role, and tour annotations:

```json
{
  "extras": {
    "power_gen": {
      "role": "coil_former",
      "materialRingIndex": 12.0,
      "anchors": [
        { "name": "coil_axis", "position": [0, 0, 0] }
      ]
    }
  }
}
```

**Annotation nodes** (housing callouts linked to the SEG Explainer tour):

```json
{
  "name": "ann_coil",
  "mesh": 1,
  "translation": [5.4, 0.15, 0.2],
  "extras": {
    "annotationId": "coil"
  }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `extras.annotationId` | yes (on callout nodes) | Tour / explainer highlight id — must match `seg-tour.json` `highlights` and `seg-annotations.js` ids (`shaft`, `inner-ring`, `stator`, `separator`, `outer-ring`, `coil`, …) |
| `extras.power_gen.materialRingIndex` | no | PBR ring index for structural meshes (default `11.0`) |
| `extras.power_gen.role` | no | `housing` \| `coil_former` \| … — used for emissive / draw tagging |
| `extras.power_gen.anchors` | no | Named telemetry / rigging points (not tour ids) |

Use a small invisible **pick-proxy** mesh (see `annotation_pick_proxy` in `housing-shell.glb`) on annotation nodes. Proxies are ray-pick targets only — not drawn at runtime.

4. Drop the file under `src/public/assets/seg/` and register it in `SEG_GLTF_PROPS` (`parse-gltf-housing.js`).
5. `materialRingIndex` maps to the seg-enhanced PBR table (`ringIndex` in the instance buffer):
   - `11.0` — structural aluminum (default housing)
   - `12.0` — coil former / phenolic-ish
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
         assets/gltf/gltf-loader.js  →  SceneNode graph  →  WebGPU buffers
                   │
                   ▼
    seg-enhanced PBR pipeline (same as enhanced SEG meshes)
```

- **Loader:** `src/assets/gltf/gltf-loader.js` — hand-rolled GLB v2 (no `@loaders.gl` dependency;
  keeps Pages bundle small and matches ADR-0003 no-Three.js stance).
- **Scene graph:** `scene-node.js` + `gltf-scene.js` — hierarchy, visibility, anchor baking from `extras.power_gen`, `extras.annotationId` collection.
- **Prop registry:** `SEG_GLTF_PROPS` — housing + coil former (extensible).
- **Picking:** `gltf-pick.js` + `gltf-housing-pick.js` — CPU ray/triangle pick on annotated housing proxies (WebGPU).
- **GPU upload:** `gltf-gpu.js` — 8-float vertices (pos+normal+uv), 48-byte instances.
- **Setup:** `visualizer/setup-gltf.js` — loads enabled props after procedural core meshes.
- **Draw:** `DeviceRenderMixin.renderGltfHousing` — SEG focus only; procedural rollers unchanged.

## Sim-driven material overrides

Housing / former emissive trim follows `segOmega` (RPM proxy) via the instance `greenEmissive` channel,
updated each frame in `updateGltfHousingState()` (coil former scaled slightly lower).

## Collision / annotation anchors

Anchors baked at load time are exposed on the visualizer as `gltfHousingAnchors` (world space,
layout-scaled). Annotation node origins are exposed as `gltfAnnotationPoints` and override
procedural label positions in `seg-annotations.js` when `?gltfHousing=1`.

**Explainer integration**

- Click a housing callout (3D label or ray-picked proxy) → `window.segTour.goToStepForHighlight(id)`
- Deep link: `#lab=v1;mode=seg;hi=coil` restores highlight + matching tour step
- Classroom mode (`class=1`) shows hotspot dots; full labels on the active highlight
- WebGL2: 2D billboard labels only (no glTF housing mesh); clicks on labels work the same

## Bundle size notes

- Placeholder `housing-shell.glb` / `coil-former.glb` are a few KB (procedural primitives).
- Soft budget: keep committed placeholders under **~50 KB each** (see PR template).
- Prefer **Draco-free** glTF for the minimal loader; add meshopt/Draco only after evaluating
  decode cost on GitHub Pages.
- Large CAD assets should be lazy-loaded per device focus, not in the main chunk.

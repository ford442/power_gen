# glTF / GLB hybrid assets

The visualizer mixes **layout-driven procedural geometry** (rollers, rings, flux lines)
with **loaded glTF 2.0 meshes** (housing, coil former, stand, base plate, future Quanta product CAD).

Formal scene graph: `src/assets/scene/scene-node.ts` (`SceneNode`) — ADR-0005.
glTF trees are built via `buildGltfScene()` → `GltfSceneNode extends SceneNode`.

## When glTF is used

| Path | CAD glTF (housing, coil former, stand, base plate) |
|------|----------------------------|
| WebGPU (`MultiDeviceVisualizer`) | Yes — **SEG focus only** (lazy); overview stays light |
| WebGL2 fallback (`?renderer=webgl2`) | No — procedural `seg-frame-model` only (see `WEBGL2.md`) |

Disable all CAD props: `?gltfHousing=0`  
Disable coil former only: `?gltfCoilFormer=0`  
Disable stand: `?gltfStand=0`  
Disable base plate: `?gltfBasePlate=0`  
Force housing on: `?gltfHousing=1`

## Prop registry (lazy multi-prop)

Canonical registry: `src/assets/gltf/prop-registry.ts` (re-exported from `parse-gltf-housing.ts`).

| Id | Load policy | Material override | Notes |
|----|-------------|-------------------|-------|
| `housing` | `resident` | ring 11, aluminum-ish | Load on first SEG focus; keep GPU buffers when leaving |
| `coilFormer` | `focus` | ring 12, phenolic-ish | Load in SEG focus; **dispose** on mode leave |
| `stand` | `focus` | ring 13, dark metal | Four posts + cradle; **dispose** on mode leave; embeds KTX2 albedo |
| `basePlate` | `focus` | ring 13, dark metal | Floor slab below housing plinth; **dispose** on mode leave |

`resolvePropMaterial(prop, drawable)` applies registry overrides (ring index, color,
emissive scale) over glTF extras. Runtime load/dispose: `setup-gltf.ts`
`ensureGltfPropsForView()` from `onModeChange`.

## Instancing policy (procedural vs static CAD)

| Geometry | Path | Why |
|----------|------|-----|
| **Rollers / magnets** | Procedural + **GPU instancing** (`roller` instance buffer, layout-driven counts) | Counts/radii change with SEG layout presets; motion every frame; shared mesh |
| **Stator rings / flux** | Procedural / compute | Sim-driven; not authored CAD |
| **Housing, coil former, stand, base** | **Static glTF** (one draw per mesh primitive, single instance buffer for trim emissive) | Author once in Blender; rare motion; pick/annotation anchors |
| **Lab bench / frame** | Procedural `seg-frame-model` when glTF housing is off | WebGL2 always; WebGPU fallback if CAD disabled |

Do **not** instance static CAD as roller-style grids. Do **not** bake rollers into GLB —
layout presets would require re-export. Prefer one small GLB per prop + registry entry.

## Asset layout

```
src/public/assets/
  seg/
    housing-shell.glb   # generated showroom shell
    coil-former.glb     # generated coil bobbin / former
    stand.glb           # generated posts + cradle (KTX2 albedo)
    base-plate.glb      # generated floor plate
    LICENSE.md
```

Regenerate placeholders:

```bash
npm run generate:housing-glb
npm run generate:coil-former-glb
npm run generate:stand-glb
npm run generate:base-plate-glb
# or all:
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
| `extras.power_gen.materialRingIndex` | no | PBR ring index for structural meshes (default `11.0`); registry override may win |
| `extras.power_gen.role` | no | `housing` \| `coil_former` \| `stand` \| `base_plate` — used for emissive / draw tagging |
| `extras.power_gen.anchors` | no | Named telemetry / rigging points (not tour ids) |
| `extras.power_gen.compressedAlbedo` | no | Image indices `{ none, bc, etc2, astc }` for GPU-native KTX2 (stand placeholder) |

Use a small invisible **pick-proxy** mesh (see `annotation_pick_proxy` in `housing-shell.glb`) on annotation nodes. Proxies are ray-pick targets only — not drawn at runtime.

4. Drop the file under `src/public/assets/seg/` and register it in `SEG_GLTF_PROPS` (`prop-registry.ts`).
5. `materialRingIndex` maps to the seg-enhanced PBR table (`ringIndex` in the instance buffer):
   - `11.0` — structural aluminum (default housing)
   - `12.0` — coil former / phenolic-ish
   - `13.0` — dark lab base
   - See `sharedMaterialId()` in `seg-enhanced-shaders.js`

## Runtime pipeline

```
physics/constants.json     seg-layout.ts PRESET_DEFS
        │                          │
        ▼                          ▼
 procedural rollers/rings    layout worldScale + frameDims
        │                          │
        └──────────┬─────────────────┘
                   ▼
         assets/gltf/gltf-loader.ts  →  SceneNode graph  →  WebGPU buffers
                   │
                   ▼
    seg-enhanced PBR pipeline (same as enhanced SEG meshes)
```

- **Loader:** `src/assets/gltf/gltf-loader.ts` — hand-rolled GLB v2 (no `@loaders.gl` dependency;
  keeps Pages bundle small and matches ADR-0003 no-Three.js stance).
- **Scene graph:** `scene-node.ts` + `gltf-scene.ts` — hierarchy, visibility, anchor baking from `extras.power_gen`, `extras.annotationId` collection.
- **Prop registry:** `prop-registry.ts` — housing, coil former, stand, base plate.
- **Picking:** `gltf-pick.ts` + `gltf-housing-pick.ts` — CPU ray/triangle pick on annotated housing proxies (WebGPU).
- **GPU upload:** `gltf-gpu.ts` — 8-float vertices (pos+normal+uv), 48-byte instances.
- **KTX2:** `ktx2-gpu.ts` + parser-only `ktx-parse` — GPU-native BC/ETC2/ASTC (no Basis WASM). Shading still uses registry ring colors; compressed textures consume negotiated device features.
- **Setup:** `visualizer/setup-gltf.ts` — deferred until SEG focus; dispose focus-only props on leave.
- **Draw:** `DeviceRenderMixin.renderGltfHousing` — SEG focus only; procedural rollers unchanged.

## Sim-driven material overrides

Housing / former emissive trim follows `segOmega` (RPM proxy) via the instance `greenEmissive` channel,
updated each frame in `updateGltfHousingState()` (coil former scaled via registry `emissiveScale`).

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

- Placeholder GLBs are a few KB (procedural primitives; stand includes ~4×4 KTX2).
- Soft budget: keep committed placeholders under **~50 KB each** (see PR template).
- Prefer **Draco-free** glTF for the minimal loader; add meshopt/Draco only after evaluating
  decode cost on GitHub Pages.
- Large CAD assets should be lazy-loaded per device focus, not in the main chunk.

## KTX2 / texture compression

`OPTIONAL_DEVICE_FEATURES` requests `texture-compression-bc` / `etc2` / `astc` at
`requestDevice`. The stand GLB embeds GPU-native KTX2 (not `KHR_texture_basisu`).
Runtime: `selectTextureCompression` prefers **bc → astc → etc2**, skips on
fallback/software adapters (same gate as SSR / IBL bake), else uploads RGBA8 KTX2.

Telemetry: F3 adapter line `tex:bc|etc2|astc|none`; `window.getRendererInfo().textureCompression`.

**Parser dep:** `ktx-parse` (parser/serializer only — ADR-0003). No Three.js / Babylon /
PlayCanvas. No `basis_universal` WASM (UASTC deferred). Full `dist/index.mjs` is
~36 KB raw / **~7.6 KB gzip**; the app imports `read` only.

## Optional external glTF parser eval (deferred)

ADR-0005 allows evaluating a **parser-only** package (not a scene engine). Current stance:

| Option | Approx. gzip (parser) | Fits ADR-0003? | Notes |
|--------|----------------------|----------------|-------|
| Hand-rolled `gltf-loader.ts` | ~few KB in main chunk | Yes | Ships today; covers TRIANGLES + POSITION/NORMAL/UV + extras |
| `ktx-parse` | ~7.6 KB gzip (`dist/index.mjs`) | Parser-only OK | KTX2 containers only; used by `ktx2-gpu.ts` |
| `@loaders.gl/gltf` (parser subset) | typically tens of KB+ | Parser-only OK | Adds deps / tree-shaking risk; no clear win for current placeholder GLBs |
| Three.js GLTFLoader | large | **No** | Banned |

**Decision (2026-08):** keep the hand-rolled mesh loader. **2026-09:** add `ktx-parse`
for GPU-native KTX2 only. Revisit a full glTF parser only if artist CAD needs
extensions we refuse to implement (e.g. KHR_mesh_quantization + Draco) — then measure
gzip of a parser-only dep in a spike PR before merging.

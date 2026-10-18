# glTF / GLB hybrid assets

The visualizer mixes **layout-driven procedural geometry** (rollers, rings, flux lines)
with **loaded glTF 2.0 meshes** (SEG housing / coil former / stand / base plate, plus
per-device bench CAD: the transformer C-core, the Van de Graaff terminal, the
Thomson ring stand, Heron's vessel flanges and Kelvin's jars).

Formal scene graph: `src/assets/scene/scene-node.ts` (`SceneNode`) — ADR-0005.
glTF trees are built via `buildGltfScene()` → `GltfSceneNode extends SceneNode`.

## When glTF is used

| Path | CAD glTF |
|------|----------|
| WebGPU (`MultiDeviceVisualizer`) | Yes — **focus only, per device** (lazy); overview stays light |
| WebGL2 fallback (`?renderer=webgl2`) | No — procedural meshes only (see `WEBGL2.md`) |

Props are **scoped to one device each** and loaded when that device is focused.
Focusing the transformer does not touch the SEG's GLBs and vice versa, so the
cost of adding a bench's CAD is paid only by that bench's focus view.

Disable all CAD props: `?gltfHousing=0` (the **default** for every prop, so it
clears them all — but an explicit per-prop value wins, which is how
`?gltfHousing=0&gltfTransformerCore=1` shows one prop with the rest out of the
way. Pinned both ways by `npm run test:props`.)  
Disable coil former only: `?gltfCoilFormer=0`  
Disable stand: `?gltfStand=0`  
Disable base plate: `?gltfBasePlate=0`  
Disable the transformer C-core: `?gltfTransformerCore=0`  
Disable the VDG terminal: `?gltfVdgTerminal=0`  
Disable the Thomson ring stand: `?gltfThomsonStand=0`  
Disable Heron's vessels: `?gltfHeronVessels=0`  
Disable Kelvin's jars: `?gltfKelvinJars=0`  
Force housing on: `?gltfHousing=1`

## Prop registry (lazy, per device)

Canonical registry: `src/assets/gltf/prop-registry.ts` (re-exported from `parse-gltf-housing.ts`).

Every entry carries a **`deviceId`** (default `seg`). `ensureGltfPropsForView(view)`
loads the props whose `deviceId` matches the focused view and disposes every
`focus`-policy prop belonging to any other device — so the GPU never holds two
benches' CAD at once.

| Id | Device | Load policy | Material override | Notes |
|----|--------|-------------|-------------------|-------|
| `housing` | `seg` | `resident` | ring 11, aluminum-ish | Load on first SEG focus; keep GPU buffers when leaving |
| `coilFormer` | `seg` | `focus` | ring 12, phenolic-ish | Load in SEG focus; **dispose** on mode leave |
| `stand` | `seg` | `focus` | ring 13, dark metal | Four posts + cradle; **dispose** on mode leave; embeds KTX2 albedo |
| `basePlate` | `seg` | `focus` | ring 13, dark metal | Floor slab below housing plinth; **dispose** on mode leave |
| `transformerCore` | `transformer` | `focus` | ring 12, laminated steel | C-core + two bobbins — the flux *path* the procedural coils lack |
| `vdgTerminal` | `vdg` | `focus` | ring 11, polished terminal | Sphere + column + belt runs + discharge electrode |
| `thomsonStand` | `jumping-ring` | `focus` | ring 12, laminated steel | Plinth, square core, bobbin flanges, rest shoulder, travel stop — **the parts that do not move** |
| `heronVessels` | `heron` | `focus` | ring 12, glass | Plinth, sealed-vessel lids + tie rods, open basin rim, jet nozzle — **`heronLayout=classic` only** |
| `kelvinJars` | `kelvin` | `focus` | ring 11, tinned can | Header tank, spouts, drip tips, insulating pillars, open collection jars |

`resolvePropMaterial(prop, drawable)` applies registry overrides (ring index, color,
emissive scale) over glTF extras. Runtime load/dispose: `setup-gltf.ts`
`ensureGltfPropsForView()` from `onModeChange`.

**Scale and placement.** SEG props are baked through the SEG layout's `worldScale`
and frame `baseBottomY`, because the SEG assembly's size is layout-preset-driven.
Non-SEG props are baked at **scale 1, no Y offset**: they are authored in their
bench's own device-local units, and the device uniform supplies the world position
and rotation, exactly as it does for the procedural cylinder instances. That is
why each generator documents its origin — and the units it is in, which are not
metres on every bench (see **Units per bench** below).

**What each prop is for.** A bench earns CAD when the procedural stand-in leaves
out something the demonstration depends on — not because it would look nicer.

| Bench | What the shared cylinders cannot say |
|-------|-------------------------------------|
| `transformer` | Flux takes a path through iron. The stand-in is two coils in mid-air with no magnetic circuit. |
| `vdg` | The *shape* is the explanation — belt, column, isolated sphere, gap. The stand-in reads as a stack of cans. |
| `jumping-ring` | Where `h = 0` is, and where the travel stops. Without a shoulder and a top stop the ring appears to float at an arbitrary height and the plant's rigid stops have no counterpart on screen. |
| `heron` | Which volume is **sealed**. Four identical cylinders cannot distinguish the open catch basin from the closed air vessel, which is the entire hydraulic argument. |
| `kelvin` | Where the water comes from, and that the collectors are **insulated**. The stand-in draws buckets standing on nothing, fed from nowhere. |

**Props are additive, and back faces are culled.** `render()` draws a bench's CAD
*before* its procedural mesh, so the GLB is a backdrop the instances draw over —
not a replacement. And `segEnhanced` is the only pipeline in the repo with
`cullMode: 'back'`, so a single-sided wall wrapped around a procedural instance
shows only its near half and hides whatever is inside it. That is why
`heronVessels` marks the vessel *ends* instead of walling them, and why
`kelvinJars` puts the jar under the collection can rather than around it: the
particle passes draw inside those volumes, and an opaque near wall would be a
worse read than no prop at all.

**What stays procedural, deliberately.** CAD is baked and static; anything whose
position or glow *is* the simulation must not be baked into it:

- The **jumping ring** itself — its Y is `ringHeightM` straight out of the plant,
  and it is the only thing on that bench that moves. Its winding courses glow
  with `I_p`, so they stay instanced too.
- Kelvin's **induction rings** — `MATERIAL_KELVIN_RING` (ring index 100) torus
  instances the fragment shader draws as ring geometry, glowing with the
  accumulated charge.
- Heron's **water column and jet** — particle passes, not geometry.

**Preset-shaped benches.** SEG's layout presets rescale one assembly, so its props
bake through `worldScale` (`layoutScaled: true`). Heron's five presets instead move
the vessels to different heights and re-route the plumbing: no single GLB follows
them and no scale factor can. `heronVessels` is therefore baked for `classic` and
`parseGltfHeronVesselsEnabled()` returns false for the other four, which keep the
procedural vessels they already had. `setHeronLayoutPreset()` re-runs
`ensureGltfPropsForView()`, so switching preset *without leaving the bench* frees
the classic GLB's GPU buffers rather than leaving it hanging in a tower layout.
Both directions are pinned by `npm run test:props`.

The gate asks the **session**, not the URL: `LabSession` publishes its resolved
preset to `window.HERON_LAYOUT_PRESET`, because `applyStoredHeronLayout()` lets a
`localStorage` preset override `?heronLayout=` at boot. A prop that read the query
string would load the classic GLB into a stored tower layout on a cold page.

**Pick / annotation proxies** are still SEG-only. Non-SEG props are drawn and
anchored but not ray-picked, because the explainer tour's highlight ids
(`seg-tour.json`) are SEG's. A bench that wants callouts adds annotation nodes and
its own tour, which is a separate change.

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
    housing-shell.glb       # generated showroom shell
    coil-former.glb         # generated coil bobbin / former
    stand.glb               # generated posts + cradle (KTX2 albedo)
    base-plate.glb          # generated floor plate
    LICENSE.md
  quanta/
    transformer-core.glb    # generated laminated C-core + bobbins   (~15 KB)
    vdg-terminal.glb        # generated sphere + column + belt + gap (~42 KB)
    thomson-stand.glb       # generated plinth + core + bobbin + stops (~32 KB)
    LICENSE.md
  lab/
    heron-vessels.glb       # generated lids + basin rim + plinth + jet (~37 KB)
    kelvin-jars.glb         # generated tank + spouts + jars + pillars (~37 KB)
    LICENSE.md
```

`quanta/` holds the Quanta benches (`src/devices/quanta/`); `lab/` holds the
original lab devices, which live outside that directory.

Regenerate placeholders:

```bash
npm run generate:seg-gltf      # housing, coil former, stand, base plate
npm run generate:quanta-gltf   # transformer core, VDG terminal, Thomson stand
npm run generate:lab-gltf      # Heron vessels, Kelvin jars
npm run generate:gltf          # all three groups
```

Shared primitives live in `scripts/lib/seg-placeholder-glb.mjs`: `box`,
`cylinder` (Y or X axis, optional caps), `sphere` (low-poly lat/long), `merge`,
and the GLB/KTX2 packer. A new prop should be a few lines of those rather than a
new packer.

**Units per bench.** `transformer` and `vdg` are authored in metres, tracking
`physics/constants.json`. `heron`, `kelvin` and `jumping-ring` are **not**: their
procedural meshes are laid out in device-local *render* units, because the shared
instance cylinder is r = 0.8, h = 2.5 (`deviceCylinder`) and carries no
per-instance scale. Each generator names the TS constants it tracks
(`PRESET_DEFS.classic`, `buildKelvinInstances`, `RING_SCENE`) — copy the numbers
from there, and never re-derive a render-unit bench from its SI constants.

`npm run test:props` is the guard: every registry entry's URL must exist, parse
with **this repo's own** hand-rolled loader, carry positions/normals/UVs, and sit
under its `softBudgetBytes`. A generator that emits something the loader cannot
read fails CI instead of failing at focus time. It also checks each file against
the glTF spec's structural rules (every accessor fits its bufferView, views fit
the BIN chunk, strides and alignment), because this loader is lenient and
external tools such as cgltf / gltfpack are not.

## Authoring workflow (Blender → glTF)

1. Model Y-up, in **that bench's own units and origin** — not one global
   convention (see **Units per bench** above):

   | Bench | Units | Origin |
   |-------|-------|--------|
   | `seg` | metres | SEG assembly centre; baked through `worldScale` / `baseBottomY` |
   | `transformer`, `vdg` | metres, tracking `physics/constants.json` | bench floor plane |
   | `heron`, `kelvin`, `jumping-ring` | **device-local render units** (the shared instance cylinder is r = 0.8, h = 2.5) | the bench's own procedural origin |

   For a render-unit bench, copy the numbers from the TS layout it has to line up
   with (`PRESET_DEFS.classic`, `buildKelvinInstances`, `RING_SCENE`) rather than
   converting from the SI constants — the two are deliberately separate.
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
| `extras.power_gen.role` | no | `housing` \| `coil_former` \| `stand` \| `base_plate` \| `transformer_core` \| `vdg_terminal` \| `thomson_stand` \| `heron_vessels` \| `kelvin_jars` — used for emissive / draw tagging |
| `extras.power_gen.deviceId` | no | Which bench the prop belongs to (default `seg`). The **registry** entry is authoritative; this is for humans reading the GLB |
| `extras.power_gen.anchors` | no | Named telemetry / rigging points (not tour ids) |
| `extras.power_gen.compressedAlbedo` | no | Image indices `{ none, bc, etc2, astc }` for GPU-native KTX2 (stand placeholder) |

Use a small invisible **pick-proxy** mesh (see `annotation_pick_proxy` in `housing-shell.glb`) on annotation nodes. Proxies are ray-pick targets only — not drawn at runtime.

4. Drop the file under the directory for its bench — `src/public/assets/seg/`
   (SEG), `src/public/assets/quanta/` (a bench in `src/devices/quanta/`) or
   `src/public/assets/lab/` (`heron`, `kelvin`) — and register it in
   `SEG_GLTF_PROPS` (`prop-registry.ts`) with its `deviceId`, load policy,
   `enabled` predicate and `softBudgetBytes`. The directory groups by where the
   bench's code lives, **not** by units: `quanta/` holds both metre-authored
   (`transformer`, `vdg`) and render-unit (`jumping-ring`) assets.
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
- **Prop registry:** `prop-registry.ts` — per-device entries (SEG housing / coil former / stand / base plate, transformer core, VDG terminal).
- **Picking:** `gltf-pick.ts` + `gltf-housing-pick.ts` — CPU ray/triangle pick on annotated housing proxies (WebGPU, **SEG only**).
- **GPU upload:** `gltf-gpu.ts` — 8-float vertices (pos+normal+uv), 48-byte instances.
- **KTX2:** `ktx2-gpu.ts` + parser-only `ktx-parse` — GPU-native BC/ETC2/ASTC (no Basis WASM). Shading still uses registry ring colors; compressed textures consume negotiated device features.
- **Setup:** `visualizer/setup-gltf.ts` — deferred until the owning device is focused; dispose focus-only props on leave (including another device's).
- **Draw:** `DeviceRenderMixin.renderGltfHousing` for SEG, `renderGltfDeviceProps` for every other bench (called from the shared `render()`); procedural meshes unchanged.

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

- Placeholder GLBs are a few KB to ~42 KB (procedural primitives; stand includes ~4×4 KTX2).
- Soft budget: keep committed placeholders under **~50 KB each** (see PR template),
  enforced per entry by `softBudgetBytes` and `npm run test:props`.
- Sphere segment counts are the knob that blows the budget: the VDG terminal is
  14×8 (~42 KB) and 16×8 put it at ~50.6 KB, i.e. against the ceiling.
- Prefer **Draco-free** glTF for the minimal loader. meshopt was measured against
  the committed set (2026-10) and is **not needed yet** — see
  *meshopt decode — measured, not needed yet* below for the byte table and the
  re-measure trigger.
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

**Re-evaluated 2026-09 (epic #203 WS B), still deferred.** The epic said to
reconsider a parser swap *only if* multi-device CAD broke the custom loader. It did
not: the transformer core and the VDG terminal go through `parseGlb` /
`extractGltfMeshes` unchanged, because the thing that would break it — quantized
attributes or a meshopt/Draco buffer — is a property of the *exporter*, not of how
many devices have props. Two more small, triangulated, float-attribute GLBs are the
same job as the first four. `npm run test:props` now parses every registry GLB with
that loader in CI, so the day an artist asset does need an extension, it fails there
with a named prop instead of silently at focus time. That failure is the trigger to
re-open this, and nothing before it is.

### meshopt decode — measured, not needed yet (#217 WS B)

#217 allowed a meshopt decoder "only if measured". Measured 2026-10 with
`gltfpack` 1.2.0 (`-kn -km -ke`, so nodes, materials and `extras.power_gen`
survive) against the nine committed GLBs, and `meshoptimizer` 1.2.0's
`meshopt_decoder.mjs` for the decoder. Neither was added to `package.json`. GitHub
Pages serves `.glb` as `content-encoding: gzip` (checked on the live demo:
`vdg-terminal.glb` arrives as 9127 B), so **gzip is the column that ships**.

| Prop | Today raw | Today gzip | Welded, no ext. (gzip) | Quantized (gzip) | meshopt + quantized `-cc` (gzip) |
|------|----------:|-----------:|-----------------------:|-----------------:|---------------------------------:|
| `seg/base-plate` | 1 996 | 707 | 638 | 697 | 838 |
| `seg/coil-former` | 13 996 | 3 145 | 2 058 | 2 033 | 1 506 |
| `seg/housing-shell` | 8 260 | 1 967 | 1 529 | 1 619 | 1 507 |
| `seg/stand` | 8 396 | 2 000 | 1 607 | 1 633 | 1 391 |
| `quanta/transformer-core` | 15 276 | 3 012 | 2 112 | 2 077 | 1 530 |
| `quanta/vdg-terminal` | 43 228 | 9 045 | 5 577 | 4 976 | 3 071 |
| `quanta/thomson-stand` | 32 076 | 5 765 | 3 658 | 3 561 | 2 055 |
| `lab/heron-vessels` | 37 604 | 6 513 | 4 198 | 4 015 | 2 273 |
| `lab/kelvin-jars` | 37 564 | 6 662 | 4 279 | 4 099 | 2 393 |
| **All nine** | **198 396** | **38 816** | **25 656** | **24 710** | **16 564** |
| Decoder (`meshopt_decoder.mjs`) | 29 059 | **7 783** | — | — | needed |

Bytes. *Welded* is `gltfpack -noq`: no extension at all — it merges duplicate
vertices (the VDG sphere goes 1200 → 486), drops degenerate triangles and drops
`TEXCOORD_0`, which no prop's material samples. *Quantized* adds
`KHR_mesh_quantization` (int16/int8 attributes, no decoder library, but a loader
change). The last column adds `EXT_meshopt_compression`, which needs the decoder.

**Why not yet:**

- Most of the 22 KB between today and meshopt (38.8 → 16.6 KB) is **not
  meshopt**: welding and dropping unused UVs take it to 25.7 KB with no
  extension and no decoder. Measured against *that*, meshopt + quantization
  saves **9.1 KB across all nine props together** — barely more than the
  **7.8 KB** decoder it needs.
- Props load **per focused bench**, so nobody downloads all nine at once. The
  most a single focus view saves over the welded baseline is 2.5 KB (VDG);
  SEG's four props together save 0.6 KB. Every single-bench visit would pay
  more for the decoder than it saves.
- It also costs loader code for two extensions (`EXT_meshopt_compression`
  bufferView decode, `KHR_mesh_quantization` dequantize) feeding a GPU path
  that uploads float32 8-float vertices anyway (`gltf-gpu.ts`), so there is no
  VRAM win either.

**When to re-measure.** meshopt beats the welded baseline by ~35 % at these
densities, so it pays for its own decoder once one visit loads roughly
**7.8 KB / 0.35 ≈ 22 KB** of welded, gzipped GLB — about 4× today's largest
focus view (VDG, 5.6 KB). An artist asset of a few thousand vertices per bench
would get there; that is the trigger. `npm run test:props` is where it shows up:
the loader implements no extensions, so any GLB whose `extensionsRequired`
lists one (gltfpack's `-q` / `-cc` output does) fails there by name instead of
decoding as garbage.

**The cheap part, if wanted before then:** welding plus dropping the unused UVs
is ~13 KB gzipped across the set with no new dependency. It is not done here:
UVs are part of the loader contract (`gltf-gpu.ts` uploads 8-float vertices,
which `test:props` checks), and the stand's KTX2 albedo may want them back.

**Spec validity (fixed while measuring).** gltfpack first refused *every*
committed GLB with "buffer too short". All three writers
(`scripts/lib/seg-placeholder-glb.mjs`, the housing and coil-former generators)
described the interleaved stride-32 vertex block as three bufferViews of
`count × elementSize` bytes, so every vertex accessor overran its view ~2.7×.
This repo's loader reads by stride and never noticed; external tools did. The
writers now emit one `count × 32` bufferView with accessors at byte offsets
0 / 12 / 24. The regenerated GLBs decode **identically** through
`parseGlb` + `extractGltfMeshes` (every vertex, index and node extra), and
`npm run test:props` now checks the spec's structural rules on every prop
(`glbSpecProblems`), so a writer cannot drift back.

**Artist CAD.** None yet. No artist-authored GLB replaces a placeholder in this
change; the SEG housing and coil former are still the first candidates (#217).
What changed for that work is that the placeholders an artist starts from are
now files external tools accept.

### Basis UASTC — evaluated, not adopted

The epic allowed a `basis_universal` WASM decode path "only if artist assets need
it". They do not, and the reason is structural rather than a matter of taste:

| | GPU-native KTX2 (today) | UASTC + Basis WASM |
|---|---|---|
| Decode cost | **None.** `selectTextureCompression` negotiates bc / astc / etc2 at `requestDevice` and uploads the matching payload straight to the GPU | A WASM transcode on the main thread (or a worker plus a transfer) before the first draw |
| Bundle | `ktx-parse` `read` only, ~7.6 KB gzip | Above, plus a few hundred KB of WASM |
| What it buys | One container per format, authored offline | *One* container for every format — a shipping-size win for large texture sets |
| What we have | Two 4×4 solid albedos | — |

The win UASTC exists for is not having to ship several format variants of large
textures. Our placeholders are 4×4 solid colours, so there is nothing to win and a
WASM blob to lose. Revisit when a prop ships a real texture *set* — say more than
~1 MB of albedo/normal/roughness across benches — and measure transcode time on the
Pages build before committing.

# WebGPU bind group contracts

Canonical binding numbers for the multi-device WebGPU path.  
**Layout source of truth:** `src/pipeline-layout/` (re-exported from `src/pipeline-layout-cache.ts`)  
**WGSL source of truth:** `src/shaders/passes/` + `src/shaders/common/`

When changing a binding, update **both** the layout module and the pass WGSL in the same PR.

## New pass checklist

1. Add a pass in `src/shaders/passes/` with explicit `@binding` / `@group`.
   A draw in the scene pass reads camera / lighting / IBL / shadow from the
   shared **`@group(0)` frame group** and declares only its own resources at
   **`@group(1)`**; compute and post passes keep a single `@group(0)`.
2. Add the layout to `src/pipeline-layout/bind-group-schema.json` (`"group": 1`
   for a scene draw), run `npm run codegen:bindings`, and register it in the
   matching `src/pipeline-layout/layouts/*.ts` module — scene pipeline layouts
   are `['frame', <own>]`. **No** `layout: 'auto'`.
3. Document bindings in this file.
4. Run `npm run check:bindings`, `npm run check:wgsl`, and `npm run check:post`
   when CPU↔WGSL struct coupling exists.

## Architecture

| Piece | Role |
|-------|------|
| `PipelineLayoutCache` | Creates all `GPUBindGroupLayout` / `GPUPipelineLayout` once; caches shared pipelines |
| `DevicePipelineManager` | Attaches shared pipeline handles to each device (no recompile) |
| Bind group sites | Call `pipelineCache.createBindGroup(layoutName, entries)` |

There is **no** `layout: 'auto'` in production pipelines.

## Scene pass: `@group(0)` frame + `@group(1)` per draw (#225 §3)

Every pipeline drawn in the scene pass (and the shadow pass) has the pipeline
layout `[frame, <own>]`. The scene pass binds the frame group **once**
(`render-passes.ts` `encodeScene`, `visualizer/frame-bindings.ts`); bind groups
survive `setPipeline`, so each draw only sets `@group(1)`. A render bundle's
`executeBundles` resets pass state, so the pass rebinds group 0 after each one
(`visualizer/render-bundles.ts`).

### `frame` — shared scene data (`@group(0)`)

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame `Uniforms` (`viewProj`, time, resolution, camera, light packs) |
| 4 | uniform | VS | SEG layout pack |
| 5 | uniform | FS | `LightingConfig` (key / fill / rim / ground, ambient, env strength, IBL levels) |
| 6 | storage (read) | FS | Material table |
| 7 | texture (2d-array) | FS | Prefiltered GGX environment |
| 8 | sampler | FS | Environment sampler (linear, clamp) |
| 9 | texture_depth_2d | FS | Key-light shadow map (1×1 placeholder while released) |
| 10 | sampler_comparison | FS | Shadow compare sampler (`less-equal`, linear → 2×2 hardware PCF per tap) |
| 11 | uniform | FS | `ShadowUniforms` — light viewProj, enabled / texel / bias / strength, normal offset (96 B, `common/shadow-pcf.wgsl`) |

Bindings 1–3 are unused here: they kept their pre-#225 numbers in the group-1
layouts below. Binding numbers are per group, so `particle`'s `@group(1)
@binding(4)` and the frame's `@group(0) @binding(4)` do not collide.

Two groups share this layout. The **scene** group binds the real map at 9.
The **shadow-pass** group binds `shadow-caster-uniforms` at 0 (same `Uniforms`
struct, `viewProj` = the light's matrix) and the placeholder at 9, because the
map is that pass's depth attachment.

Bindings 7–8 are the always-on prefiltered IBL chain (ADR-0005 WS2): a
`rgba16float` 2D array baked at startup and sampled in `common/pbr-eval.wgsl`.
Layers `0..IBL_SPEC_LEVELS-1` hold octahedral GGX radiance for roughness
`i/(n-1)`; the last layer holds cosine irradiance. The bake runs on the GPU
(`passes/ibl-prefilter-compute.wgsl`, the `iblPrefilter` layout below), with
the CPU bake in `src/ibl-prefilter.ts` as the fallback.

### Per-draw `DeviceUniforms`: one ring, dynamic offsets

`@group(1) @binding(1)` in `roller`, `particle`, `segEnhanced`, `fluxSegment`,
`fieldParticles` and `coil` is `hasDynamicOffset: true`, bound as a 48 B window
into **one** 256-byte-slotted buffer (`visualizer/uniform-ring.ts`). Each
(device, part) — rollers / bench / stator / wiring / ring top / ring bottom,
`DEVICE_PART` in `devices/device-render.ts` — owns a **stable** slot, so a
draw passes `setBindGroup(1, bg, [offset])` and a render bundle can record that
offset once. Every device repacks its slots in place after the physics step
(`_refreshDeviceUniforms`, `render-loop.ts`) and the frame makes **one**
`writeBuffer` of the slots in use right before submit. Nothing allocates a
`Float32Array` per draw. 256 B is the largest legal
`minUniformBufferOffsetAlignment`, so the offsets are valid on every adapter.

### `roller` — instanced mesh (rollers, fallback geometry) — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` (ring slot) |
| 2 | storage (read) | VS | Instance table |
| 3 | uniform | FS | Material uniforms |

WGSL: `passes/roller-vert.wgsl`, `passes/roller-frag.wgsl` (reads the material
table at frame binding 6 and the shadow map at 9–11)

### `particle` — particle billboards — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` |
| 3 | uniform | FS | Material |
| 4 | storage (read) | VS | `array<GpuParticle>` particles (16 B stride) |

WGSL: `passes/particle-vert.wgsl`, `passes/particle-frag.wgsl` + `common/particle.wgsl` (`GpuParticle`)

### `segEnhanced` — SEG PBR meshes and CAD props — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` |
| 2 | storage (read) | VS | Instances |
| 3 | uniform | FS | Material |

WGSL: `passes/seg-enhanced-vert.wgsl`, `passes/seg-enhanced-frag.wgsl` (frame
bindings 4–11: layout pack, lighting, IBL, shadow)

### `fluxSegment` — RK4 flux billboards — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` |
| 2 | storage (read) | VS | Flux segments |

### `fieldParticles` — field lines / energy arcs — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` |
| 4 | storage (read) | VS | Particles / arc segments |

### `energyPipe` — overview energy pipes — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform | VS+FS | Pipe uniforms (one buffer per pipe, not the ring) |
| 2 | storage (read) | VS | Pipe particles |

### `coil` — electromagnet coils — `@group(1)`

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform, dynamic offset | VS+FS | `DeviceUniforms` |
| 2 | storage (read) | VS | Coil instances |
| 3 | uniform | FS | Coil material |

## Compute and post layouts (`@group(0)` only)

### `energyPipeCompute` — overview pipe particle advection

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | `array<PipeParticle>` |
| 1 | uniform | CS | `PipeCurve` (Bezier endpoints + flow) |

WGSL: `passes/energy-pipe-compute.wgsl`

### `particleCompute` — GPU particle integration (shared)

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | Particles |
| 1 | uniform | CS | `ComputeUniforms` — time / mode / particleCount / physics / lodLevel (48 B) |

`particleCount` is the count **before** GPU LOD; the shader keeps
`particleCount >> lodLevel` particles (`common/overview-lod.wgsl`). The
`overviewCull` pass sizes its indirect draw with the same ladder, so a device
never draws particles the compute pass skipped.

### `overviewCull` — overview frustum cull → draw-indirect

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (read) | CS | `array<DeviceBounds>` device instance spheres (32 B stride) |
| 1 | uniform | CS | `CullUniforms` — viewProj, cameraPos, deviceCount, margin, vertexCount (96 B) |
| 2 | storage (rw) | CS | `array<DrawArgs>` draw-indirect args, one **stable** slot per device (16 B) |
| 3 | storage (rw) | CS | `CullOutput` — atomic visibleCount / drawnInstances + compacted index list |

WGSL: `passes/overview-cull-compute.wgsl` + `common/overview-cull.wgsl`
TS: `src/devices/overview-cull.ts` (`OverviewCullPass`) — buffer packing lives there.

One thread per device slot. Binding 2 is created with `STORAGE | INDIRECT | COPY_DST`
and consumed by `renderPass.drawIndirect(buffer, slot × 16)` in `device-render.ts`:
the slot index is stable so the CPU never needs the cull result back. Culled or
disabled devices resolve to `instanceCount = 0`.

Binding 3's compacted list is diagnostics only (`window.captureOverviewCull()`);
nothing in the frame path reads it.

### `rollerCompute` — SEG roller instance compute

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | Roller instances |
| 1 | uniform | CS | Roller uniforms |
| 2 | uniform | CS | SEG layout |

### `fieldAdvect` — field particle advection

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | Field particles |
| 1 | uniform | CS | Field uniforms |

### `choresReduce` — gpu-chores `reduce_f32`

Adopts the session `GPUDevice`. Packed f32 input only — not particle/field structs.

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (read) | CS | `array<f32>` input |
| 1 | storage (rw) | CS | Workgroup partials (`sum, min, max, sumSq`) |
| 2 | uniform | CS | `count` + pad |

### `transformerFlux` — transformer toroidal-core flux segments

Same shape as `fieldAdvect`. Writes packed `FluxSegment` (32 B) for the
`fluxSegment` render pipeline.

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | Flux segments |
| 1 | uniform | CS | `time`, `fluxN`, `k`, `segmentCount` |

### `fluxTracer` — RK4 flux line tracer

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | Flux segments |
| 1 | uniform | CS | Flux uniforms |
| 2 | storage (read) | CS | Coil boost |
| 3 | uniform | CS | SEG layout pack |

### `fdtdCompute` — 2D TM_z Yee update (ADR-0010, materials ADR-0012)

Shared by the `updateH` and `updateE` entry points of
`passes/fdtd-tmz-compute.wgsl`, dispatched alternately 6× per frame at
`@workgroup_size(8, 8)` over the 256² grid.

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | CS | `FdtdParams` (288 B, `common/fdtd-params.wgsl`) |
| 1 | storage (rw) | CS | Ez, `array<f32>` n² |
| 2 | storage (rw) | CS | Hx |
| 3 | storage (rw) | CS | Hy |
| 4 | storage (read) | CS | Material map, `array<vec2f>` n² — (1/μ_r, electric half-step loss), ADR-0012 |

Binding 4 is **always bound**, even for a vacuum slice: `params.materialFlags`
bit 0 decides whether the shader reads it, so there is one pipeline and one bind
group either way (`?fdtdMaterials=0` clears the flag).

### `fdtdSlice` — FDTD slice panel in the scene pass (ADR-0010, materials ADR-0012)

`passes/fdtd-slice.wgsl`, a six-vertex world-space quad (no vertex buffer)
drawn after the device meshes. Reads the same field buffers read-only.
Scene draw: `@group(1)`, with `viewProj` from the frame group's binding 0.

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 1 | uniform | VS, FS | `FdtdSliceParams` (32 B: center, halfExtent, gains, opacity) |
| 2 | uniform | FS | `FdtdParams` (grid size, sponge depth, winding markers) |
| 3 | storage (read) | FS | Ez |
| 4 | storage (read) | FS | Hx |
| 5 | storage (read) | FS | Hy |
| 6 | storage (read) | FS | Material map (same buffer as `fdtdCompute` binding 4) — tints and outlines the μ_r armature / σ turns, ADR-0012 |

Built at sample count 1 and 4 like the other scene draws. Slot 1 is declared
`{ format: 'rg8unorm', writeMask: 0 }` rather than `null`: current Dawn rejects
`setPipeline` when a pipeline's `null` target meets a pass attachment. Host:
`src/devices/quanta/fdtd-slice-pass.ts`, built lazily on the first frame the
gate could open.

### Post-process / environment

| Layout | Bindings |
|--------|----------|
| `sky` | `@group(1)` 0 uniform sky params (frame group at 0) |
| `grid` (pipeline layout) | `['frame']` — the floor grid needs nothing but the frame |
| `anomalyWall` | `@group(1)` 1 wall params (frame group at 0) |
| `bloomExtract` | 0 scene tex, 1 sampler, 2 params |
| `bloomBlur` | 0 tex, 1 sampler, 2 params, 3 direction |
| `bloomMip` | 0 source mip (or scene), 1 sampler, 2 params, 3 `BloomLevel` (256-byte-strided slots) — prefilter / downsample / upsample of the linear-path mip chain |
| `bloomComposite` | 0 scene, 1 bloom, 2 sampler, 3 params, 4 depth, 5 prev scene, 6 SSR reflection |
| `ssr` | 0 depth, 1 scene, 2 sampler, 3 SsrParams, 4 reflection out (storage), 5 material G-buffer |
| `iblPrefilter` | 0 IblPrefilterParams, 1 IBL array out (storage, 2d-array) |
| `taaResolve` | 0 scene, 1 history, 2 sampler, 3 depth, 4 TaaParams |
| `depthResolve` | 0 multisampled depth |

`ssr` is a compute layout (`passes/ssr-compute.wgsl`) — all six entries are
`COMPUTE`-visible; binding 4 is a write-only `rgba16float` storage texture at
half canvas resolution, and binding 5 is the `rg8unorm` metalness/roughness
G-buffer (full canvas resolution, r=metallic g=roughness) written by the scene
pass's second color target — see "Metalness/roughness G-buffer" in
`docs/LIGHTING_RIG.md`.

The scene render pass itself (`sky` → `grid` → per-device meshes →
`anomalyWall` → `energyPipe`, encoded in `render-passes.ts`) has **two** color
attachments once the G-buffer is allocated: slot 0 is the existing scene
color, slot 1 is the `rg8unorm` G-buffer. Every pipeline drawn in that pass
must declare a `fragment.targets` array with two entries to stay compatible —
`segEnhanced`/`roller` write real `{ format: 'rg8unorm' }` values at slot 1;
every other pipeline in that pass (`sky`, `grid`, `particle`, `fluxSegment`,
`energyArc`, `fieldLine`, `coil`, `anomalyWall`, `energyPipe`) declares `null`
at slot 1 instead, which is valid WebGPU (that pipeline simply doesn't write
the attachment) and needs no shader change.

`taaResolve` (`passes/taa-resolve.wgsl`) is a `FRAGMENT`-visible layout for the
temporal AA resolve, drawn with the shared `bloom-vert.wgsl` full-screen
triangle into `taaResolveTexture` (canvas format). Binding 1 is
`prevSceneTexture` — the same history target motion blur reads, holding the
previous *resolved* frame while TAA is active. Binding 3 has the same two
variants SSR does (`taaBindGroup` / `taaBindGroupResolved`): on an MSAA frame
the single-sample depth texture was never written, so the pass reads the
manually resolved depth instead. When the pass is gated off the bloom stack
reads the raw scene bind groups and this layout is unused. See "Temporal AA" in
`docs/LIGHTING_RIG.md`.

`iblPrefilter` (`passes/ibl-prefilter-compute.wgsl`) is a `COMPUTE` layout that
bakes the GGX environment chain. Binding 1 is a write-only
`texture_storage_2d_array<rgba16float>` view over **all** layers of the same
texture `segEnhanced` binding 7 samples, so the shader picks its destination
layer from `IblPrefilterParams.job.x` rather than needing a per-layer view.
Binding 0 is bound as a 160-byte slice of one params buffer at a 256-byte
stride, one slice per layer, so all layers can be dispatched into a single
compute pass without rewriting the uniform between dispatches. The host side is
`src/ibl-prefilter-gpu.ts`; it falls back to the CPU bake if the pipeline or the
`STORAGE_BINDING` usage is rejected. See "IBL prefilter" in
`docs/LIGHTING_RIG.md`.

`depthResolve` (`passes/depth-resolve.wgsl`) is a `FRAGMENT`-visible layout
with one `texture_depth_multisampled_2d` binding — the manual MSAA depth
resolve (ADR-0005 WS2; WebGPU has no `resolveTarget` for depth). Its pipeline
has zero color targets (`fragment.targets: []`) and writes
`@builtin(frag_depth)` into a regular single-sample depth attachment with
`depthCompare: 'always'`. See "4x MSAA" in `docs/LIGHTING_RIG.md`.

**MSAA pipeline variants:** every render pipeline in the scene pass listed
above is compiled at `multisample.count: 1` and, separately, at `count: 4`
(cache key suffix `_msaa4`) — `multisample` is baked into a
`GPURenderPipeline`. The 4× set is **not** built at boot: it is the `msaa`
tier in `visualizer/pipeline-tiers.ts`, compiled the first frame the MSAA
gate (`high` tier + focus) would open; until it lands those frames render 1×.
`DevicePipelineManager.applyPassVariant()` (per device) and four reference
swaps in `render-passes.ts` (sky, grid, anomalyWall, energyPipe) pick the
active variant each pass — no GPU work. Layouts are identical between
variants.

**Shadow caster variants:** `roller_shadow` and `segEnhanced_shadow` are the
same vertex shaders and layouts with no fragment stage, `cullMode: 'none'`, a
slope-scaled depth bias and a `depth32float` target (`ensureShadowCasterPipelines`).
They are the `shadow` tier: compiled on first use, never in overview.

## Shared pipeline compile policy

`PipelineTiers.boot()` (`visualizer/pipeline-tiers.ts`) builds the 1× scene
set, particle / cull / energy-pipe compute and the bloom stack in **one
`Promise.all`** of `createRenderPipelineAsync` / `createComputePipelineAsync`
before the first frame. `msaa`, `ssr`, `taa` and `shadow` compile on first use.

- `PipelineLayoutCache.getOrCreatePipeline` dedupes in-flight compiles, so two
  tiers asking for the same pipeline share one promise.
- `shaderModule()` is keyed by the **source text**: two labels with the same
  code share a module; a changed shader never hits a stale one.
- Each `DevicePipelineManager.setupPipelines()` only **assigns references**.
- SEG-only compute (roller / field advect / flux tracer) is cached by shader hash.

Expect: **O(1) pipeline compiles per shader family**, not O(devices).
`getRendererInfo().pipelineTiers` reports each tier's state and compile time.

## Schema codegen + drift check

`src/pipeline-layout/bind-group-schema.json` is the source of truth for every
bind group layout: its `group` (0 unless stated; scene draws are 1), entries
(`[binding, stages, kind, format?]`, kind `uniform-dynamic` for a ring slot)
and
the WGSL pass files of each pipeline built on it. `npm run codegen:bindings`
(`scripts/codegen-bindings.mjs`) emits
`src/pipeline-layout/generated/bind-group-layouts.ts`; the registrars in
`src/pipeline-layout/layouts/*.ts` pass `BGL.<name>` to `r.bgl(...)` — no
hand-written entry arrays.

`npm run check:bindings` (part of `npm run validate`) fails when the generated
TS is stale, a registrar bypasses `BGL.<name>`, a schema layout is unregistered,
a pipeline's WGSL declares a binding the layout lacks or with a different
resource kind / storage-texture format, a layout entry is used by no pipeline,
or a pass file with bindings maps to no layout (unless listed under
`unboundPasses`). Each layout is checked against the WGSL declarations of
**its** group; per-stage limits count a scene pipeline's frame + own entries
together. Coverage: **all** layouts.

To change a binding: edit the schema + the WGSL, then `npm run codegen:bindings`.
Keep the tables above in sync by hand (they document meaning, not numbers).

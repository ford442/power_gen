# WebGPU bind group contracts

Canonical binding numbers for the multi-device WebGPU path.  
**Layout source of truth:** `src/pipeline-layout/` (re-exported from `src/pipeline-layout-cache.ts`)  
**WGSL source of truth:** `src/shaders/passes/` + `src/shaders/common/`

When changing a binding, update **both** the layout module and the pass WGSL in the same PR.

## New pass checklist

1. Add a pass in `src/shaders/passes/` with explicit `@binding` / `@group(0)`.
2. Register `GPUBindGroupLayout` + `GPUPipelineLayout` in the matching `src/pipeline-layout/layouts/*.ts` module — **no** `layout: 'auto'`.
3. Document bindings in this file (table under **Group 0 layouts**).
4. Run `npm run check:wgsl` and `npm run check:post` when CPU↔WGSL struct coupling exists.

## Architecture

| Piece | Role |
|-------|------|
| `PipelineLayoutCache` | Creates all `GPUBindGroupLayout` / `GPUPipelineLayout` once; caches shared pipelines |
| `DevicePipelineManager` | Attaches shared pipeline handles to each device (no recompile) |
| Bind group sites | Call `pipelineCache.createBindGroup(layoutName, entries)` |

There is **no** `layout: 'auto'` in production pipelines.

## Group 0 layouts (device / scene)

All current shaders use **@group(0)** only. Multi-group layouts can be added later without renumbering bindings inside a group.

### `roller` — instanced mesh (rollers, fallback geometry)

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame (`viewProj`, time, camera, lights) |
| 1 | uniform | VS+FS | Per-device uniforms |
| 2 | storage (read) | VS | Instance table |
| 3 | uniform | FS | Material uniforms |
| 5 | storage (read) | FS | Material table |

WGSL: `passes/roller-vert.wgsl`, `passes/roller-frag.wgsl`

### `particle` — particle billboards

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 3 | uniform | FS | Material |
| 4 | storage (read) | VS | `array<GpuParticle>` particles (16 B stride) |

WGSL: `passes/particle-vert.wgsl`, `passes/particle-frag.wgsl` + `common/particle.wgsl` (`GpuParticle`)

### `segEnhanced` — SEG PBR meshes

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 2 | storage (read) | VS | Instances |
| 3 | uniform | FS | Material |
| 4 | uniform | VS | SEG layout pack |
| 5 | uniform | FS | Lighting config |
| 6 | storage (read) | FS | Material table |
| 7 | texture (2d-array) | FS | Prefiltered GGX environment |
| 8 | sampler | FS | Environment sampler (linear, clamp) |

WGSL: `passes/seg-enhanced-vert.wgsl`, `passes/seg-enhanced-frag.wgsl`

Bindings 7–8 are the always-on prefiltered IBL chain (ADR-0005 WS2): a
`rgba16float` 2D array baked at startup and sampled in `common/pbr-eval.wgsl`.
Layers `0..IBL_SPEC_LEVELS-1` hold octahedral GGX radiance for roughness
`i/(n-1)`; the last layer holds cosine irradiance. The bake runs on the GPU
(`passes/ibl-prefilter-compute.wgsl`, the `iblPrefilter` layout below), with
the CPU bake in `src/ibl-prefilter.ts` as the fallback.

### `fluxSegment` — RK4 flux billboards

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 2 | storage (read) | VS | Flux segments |

### `fieldParticles` — field lines / energy arcs

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 4 | storage (read) | VS | Particles / arc segments |

### `energyPipe` — overview energy pipes

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Pipe uniforms |
| 2 | storage (read) | VS | Pipe particles |

### `energyPipeCompute` — overview pipe particle advection

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | storage (rw) | CS | `array<PipeParticle>` |
| 1 | uniform | CS | `PipeCurve` (Bezier endpoints + flow) |

WGSL: `passes/energy-pipe-compute.wgsl`

### `coil` — electromagnet coils

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 2 | storage (read) | VS | Coil instances |
| 3 | uniform | FS | Coil material |

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

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS | Global frame uniforms (`viewProj`) |
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
| `sky` | 0 uniform sky params |
| `empty` | (none) — floor grid |
| `anomalyWall` | 0 global, 1 wall params |
| `bloomExtract` | 0 scene tex, 1 sampler, 2 params |
| `bloomBlur` | 0 tex, 1 sampler, 2 params, 3 direction |
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
`anomalyWall` → `energyPipe`, encoded in `render-loop.ts`) has **two** color
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
above (11 total) is compiled **twice** — once at `multisample.count: 1`
(the default) and once at `count: 4`, cache key suffix `_msaa4` — since
`multisample` is baked into a `GPURenderPipeline` at creation and can't be a
runtime toggle. Both are created eagerly in `ensureDevicePipelines(shaders,
{ sampleCount: 4 })` / the equivalent `ensureXPipeline(..., { sampleCount: 4
})` calls, not lazily on first use. `DevicePipelineManager.applyMsaaState()`
(per-device) and a handful of `if (this.XPipelineBase) this.XPipeline =
msaaActive ? ... : ...` lines in `render-loop.ts` (for the four
non-per-device pipelines: sky, grid, anomalyWall, energyPipe) pick the active
variant once per frame — cheap reference reassignment, no GPU work. Layouts
(bind group + pipeline layout) are identical between variants; only
`multisample` differs.

## Shared pipeline compile policy

`PipelineLayoutCache.ensureDevicePipelines(shaders)` runs **twice** at multi-device init
(`{ sampleCount: 4 }` on the second call — see "MSAA pipeline variants" above):

- Creates roller, particle, segEnhanced, fluxSegment, energyArc, fieldLine, coil, particleCompute
  (the last only on the `sampleCount: 1` call — compute pipelines have no multisample state)
- Each `DevicePipelineManager.setupPipelines()` only **assigns references** (cache hits)
- SEG-only compute (roller / field advect / flux tracer) is also cached by shader hash

Expect: **O(1) pipeline compiles per shader family**, not O(devices).

## Drift check

`npm run check:bindings` (`scripts/check-bindings.mjs`, part of `npm run validate`)
diffs each `r.bgl(name, [...])` in `src/pipeline-layout/layouts/fdtd.ts` and
`post.ts` against the `@group(0) @binding(N)` globals in that layout's WGSL
pass file(s) — a binding added, removed, or renumbered on either side without
the other fails the check instead of surfacing as a runtime bind-group-creation
or pipeline-validation error. Scope today is the `fdtd*` and post-process/
environment layouts (this file's two tables above); extend `LAYOUT_WGSL_FILES`
in the script when adding a layout to those two registrars. `roller` /
`particle` / `segEnhanced` / etc. (device-mesh, particle, cull layouts) are not
covered yet — still keep those manually aligned with this file.

## Optional future: schema codegen

A shared JSON/TS schema could emit WGSL `@binding` constants and JS layout entries, replacing the regex-based drift check above and extending it to every layout. Until then, keep this file and `src/pipeline-layout/layouts/*.ts` manually aligned for layouts outside `check:bindings`'s scope.

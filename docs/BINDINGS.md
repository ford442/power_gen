# WebGPU bind group contracts

Canonical binding numbers for the multi-device WebGPU path.  
**JS source of truth:** `src/pipeline-layout-cache.js`  
**WGSL source of truth:** `src/shaders/generators/*` and `src/shaders/*.wgsl`

When changing a binding, update **both** the layout cache and the shaders in the same PR.

## New compute pass checklist

1. Add a `@compute` entry in `src/shaders/passes/` (or a generator) with explicit `@binding` / `@group(0)`.
2. Register `GPUBindGroupLayout` + `GPUPipelineLayout` in `src/pipeline-layout-cache.js` — **no** `layout: 'auto'`.
3. Document bindings in this file (table under **Group 0 layouts**).
4. Run `npm run check:wgsl` so naga validates the expanded module.

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

WGSL: `roller-shaders.js`

### `particle` — particle billboards

| Binding | Type | Stages | Resource |
|---------|------|--------|----------|
| 0 | uniform | VS+FS | Global frame |
| 1 | uniform | VS+FS | Per-device uniforms |
| 3 | uniform | FS | Material |
| 4 | storage (read) | VS | `array<GpuParticle>` particles (16 B stride) |

WGSL: `particle-shaders.js` + `common/particle.wgsl` (`GpuParticle`)

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

WGSL: `seg-enhanced-shaders.js`

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
JS: `src/devices/overview-cull.js` (`OverviewCullPass`) — buffer packing lives there.

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

### Post-process / environment

| Layout | Bindings |
|--------|----------|
| `sky` | 0 uniform sky params |
| `empty` | (none) — floor grid |
| `anomalyWall` | 0 global, 1 wall params |
| `bloomExtract` | 0 scene tex, 1 sampler, 2 params |
| `bloomBlur` | 0 tex, 1 sampler, 2 params, 3 direction |
| `bloomComposite` | 0 scene, 1 bloom, 2 sampler, 3 params, 4 depth, 5 prev scene |

## Shared pipeline compile policy

`PipelineLayoutCache.ensureDevicePipelines(shaders)` runs **once** at multi-device init:

- Creates roller, particle, segEnhanced, fluxSegment, energyArc, fieldLine, coil, particleCompute
- Each `DevicePipelineManager.setupPipelines()` only **assigns references** (cache hits)
- SEG-only compute (roller / field advect / flux tracer) is also cached by shader hash

Expect: **O(1) pipeline compiles per shader family**, not O(devices).

## Optional future: schema codegen

A shared JSON/TS schema could emit WGSL `@binding` constants and JS layout entries. Until then, keep this file and `pipeline-layout-cache.js` manually aligned.

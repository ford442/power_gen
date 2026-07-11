# WebGPU bind group contracts

Canonical binding numbers for the multi-device WebGPU path.  
**JS source of truth:** `src/pipeline-layout-cache.js`  
**WGSL source of truth:** `src/shaders/generators/*` and `src/shaders/*.wgsl`

When changing a binding, update **both** the layout cache and the shaders in the same PR.

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
| 4 | storage (read) | VS | `array<vec4f>` particles (16 B stride) |

WGSL: `particle-shaders.js`

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
| 1 | uniform | CS | Time / mode / physics |

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

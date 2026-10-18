# WebGPU device setup

Primary path: `src/webgpu-manager.ts` → `MultiDeviceVisualizer`.  
**Automatic WebGL2 fallback is disabled** — probe fail → hard-fail UI
(`src/renderers/webgpu-probe.ts`, `window.webgpuProbe`).  
WebGL2 stays in-tree for explicit `?renderer=webgl2` only (`docs/WEBGL2.md`).

## Boot probe (required)

| Step | Module |
|------|--------|
| Browser brand + `navigator.gpu` | `probeWebGPU()` |
| `requestAdapter` + adapter.info / features / limits | same |
| Ephemeral `requestDevice` then **destroy** | validates device path without leaving a second live device |
| Fail | `showWebGPUHardFail` — **no** `getContext('webgl2')` |

Long-lived device: only `WebGPUManager.init()` / multi-device visualizer.
gpu-chores adopts that device; it never requests one after a failed probe.

## Single long-lived device

| Who | Calls `requestAdapter`? |
|-----|-------------------------|
| Boot probe | Once (then optional ephemeral device destroyed) |
| `WebGPUManager.init()` | Once for the session device |
| `WebGPUManager.reinit()` (device-lost recovery) | **Yes, once per loss** — the old adapter was *consumed* by its first `requestDevice` (spec), so asking it again rejects with `OperationError`. Still one live device: the lost one is dead |
| `PerformanceProfiler` | **No** — receives `{ adapter, adapterInfo }` from the manager |
| gpu-chores | **No** — adopts session device only |
| Debug / GPU tier | Uses profiler’s cached `adapterInfo` |

Do not open a WebGL2 context to “rescue” multi-device after probe failure.

The device descriptor is labelled end to end, so validation errors name a real
object instead of `Device #1` / `Queue #1`:

```js
adapter.requestDevice({
  requiredFeatures, requiredLimits,
  label: 'seg-primary-device',
  defaultQueue: { label: 'seg-queue' }   // uncapturederror / DevTools attribution
})
```

## Canvas configuration

| Setting | Value | Why |
|---------|-------|-----|
| `format` | `getPreferredCanvasFormat()` (`bgra8unorm` / `rgba8unorm`); **`rgba16float`** with `?hdr=1` on an HDR display | Extended tone mapping only takes effect on a float canvas — on an 8-bit one `?hdr=1` did nothing before #223 |
| `alphaMode` | **`opaque`** | Full-viewport canvas; HTML overlays do not need canvas alpha (slight compositing win) |
| `colorSpace` | **`srgb`** default; **`display-p3`** if `?p3=1` | CI screenshots stay sRGB; P3 is opt-in for showroom metals |
| `toneMapping` | `{ mode: 'standard' }` default; `'extended'` if `?hdr=1` **and** `(dynamic-range: high)` (linear colour pipeline only) | SDR composite applies the filmic curve; with `extended` it skips it (`outputLinearHdr`) so the compositor is not double-tonemapped |
| `viewFormats` | preferred UNORM + its `-srgb` sibling | The linear pipeline's composite renders through the `-srgb` view (hardware sRGB encode) |
| `usage` | `RENDER_ATTACHMENT \| COPY_SRC` | Present + optional readback/screenshots |

Scene color is **not** the swapchain (`bloomSceneTexture`). Do **not** set MSAA on `configure()`. Offscreen `sampleCount` is `1` via `WebGPUManager.offscreenColorDescriptor()` for the base scene/G-buffer textures; the ADR-0005 WS2 showroom MSAA path (`high` tier + focus mode) uses separate `sampleCount: 4` textures with manual color `resolveTarget` + a manual depth resolve — see "4x MSAA" in `docs/LIGHTING_RIG.md`.

Override: `new WebGPUManager(canvas, { alphaMode: 'premultiplied' })` if a future UI needs canvas alpha.

### Canvas size

`canvasPixelSize()` (`webgpu-init/canvas.ts`) sizes the backing store, and every post target with it:

1. **Exact device pixels** from a `ResizeObserver` on the canvas with `box: 'device-pixel-content-box'`. `clientWidth × devicePixelRatio` can land a pixel off at fractional DPR (1.25 / 1.5), and the compositor then resamples the whole frame — a soft blur on every line. The observer also fires on a DPR change (window dragged to another monitor). Browsers without the box option (Safari) fall back to `clientWidth × dpr`.
2. **`?renderScale=0.5..1`** — render at a fraction of device pixels and let the browser upscale (classroom projectors, integrated GPUs). Clamped; anything else is 1.
3. **Clamped to `device.limits.maxTextureDimension2D`**, one factor for both axes so the aspect ratio is unchanged.

## Colour pipeline (`?color=`)

Resolved once at boot by `resolveColorTargets()` in `webgpu-init/color-pipeline.ts` — every scene pipeline is built against the scene format, so the mode cannot change without a reload. `getRendererInfo()` / the boot log (`[WebGPU] Canvas configured: … color= scene= output= bloom=`) report it.

| | `linear` (default) | `legacy` |
|---|---|---|
| Scene colour, 4× MSAA twin, TAA resolve, history | **`rg11b10ufloat`** when `rg11b10ufloat-renderable` is enabled, else **`rgba16float`** — values above 1.0 survive into bloom and TAA | canvas format (8-bit UNORM; clips at 1.0) |
| Bloom | half-res **mip chain** (≤ 6 levels, 13-tap down / tent up) in the scene format | full-res extract → blur X → blur Y |
| Composite target | canvas **`-srgb` view** — the hardware applies the sRGB OETF; grain + vignette are graded in display space | canvas UNORM view, **no encode** (the pre-#223 output) |
| `?hdr=1` (HDR display) | `rgba16float` canvas, `toneMapping: 'extended'`, scene-referred linear (1.0 = SDR white), sRGB-encoded in the shader — a float canvas has no `-srgb` view but an `srgb`-tagged canvas still expects encoded values (WebGPU §3.11) | ignored (logged) |
| Look presets | `getLightingPreset(look, 'linear')`: light tints and sky dome decoded to linear, bloom threshold in scene-referred units — `docs/LIGHTING_RIG.md` → Colour pipeline | the pre-#223 values (also what WebGL2 uses) |
| glTF base colour (KTX2) | uploaded as the `-srgb` twin (`rgba8unorm-srgb`, `bc1-rgba-unorm-srgb`, …) so sampling decodes | UNORM, as before |

`legacy` is kept for one release as a side-by-side reference and is slated for removal after that.

## Adapter request (`featureLevel`)

`WebGPUManager.requestPreferredAdapter()` (shared with the boot probe):

1. `{ powerPreference, forceFallbackAdapter: false, featureLevel: 'core' }` — `powerPreference` is **`high-performance`** by default; `?gpuPower=low` (or `low-power`) requests `low-power` for tablet / projector carts (`gpuPowerPreference()` in `webgpu-init/adapter.ts`). The WebGL2 context honours the same param.
2. If `featureLevel` throws (older Chromium), one legacy `requestAdapter` without the key.
3. If core returns **null**, boot hard-fails. There is **no compatibility-mode retry**: the renderer needs vertex-stage storage buffers, `-srgb` canvas view formats and `textureLoad` on depth (`bloom-composite.wgsl`), none of which compatibility mode provides, so a compat device rendered a black canvas. The probe asks `compatibilityOnlyAdapter()` only to word the hard-fail message ("Only a WebGPU compatibility-mode adapter is available … Try ?renderer=webgl2").

This is **not** a second long-lived device. Probe still destroys its ephemeral device; the session still uses one `seg-primary-device`.

Fallback/software adapters (`adapter.info.isFallbackAdapter`, SwiftShader / llvmpipe / WARP) are recorded on `adapterInfo` and `window.webgpuProbe.adapter`. Profiler starts at **low** tier; SSR and IBL bake are skipped.

## Depth format

| Setting | Value | Why |
|---------|-------|-----|
| Default | **`depth24plus`** | Stencil unused; lower memory than `depth24plus-stencil8` |
| When SSR is on (and not fallback/software) | **`depth32float`** | Better ray-march precision |
| Pipelines | `visualizer.depthFormat` / `webgpu.depthFormat` | Single source of truth |
| Render pass | `WebGPUManager.depthStencilAttachment(view, { format })` | Depth ops only — **no** stencil load/store on depth-only formats |

Bloom still samples depth via `createView({ aspect: 'depth-only' })`.

## Optional features (never hard-required)

Negotiated in `WebGPUManager.negotiateFeatures()` when the adapter supports them:

| Feature | Status | When enabled | Notes |
|---------|--------|----------------|-------|
| `timestamp-query` | **used** | URL has `?gpuTiming=1` | Default **off**. Written via pass-descriptor `timestampWrites` (start of the first compute pass → end of the composite pass); the removed `GPUCommandEncoder.writeTimestamp` is not used. Profiler keeps `timingEnabled = false` until the debug panel toggle. |
| `rg11b10ufloat-renderable` | **used** | Always if present | Linear colour pipeline: scene colour, its MSAA twin, TAA resolve/history and the bloom mip chain (4 B/px instead of `rgba16float`'s 8). Legacy: the bloom extract/blur intermediates only. See **Colour pipeline**. |
| `texture-compression-bc` / `etc2` / `astc` | **used** | If the adapter supports them (skipped on fallback/software) | Requested at `requestDevice`. Stand GLB KTX2 albedo uploads BC1 / ASTC / ETC2 via `ktx2-gpu.ts`. F3 / `getRendererInfo().textureCompression` reports `bc` \| `etc2` \| `astc` \| `none`. |
| `float32-filterable` | **not requested** | — | No sampled `rgba32float` targets (scene / bloom are `rg11b10ufloat` or `rgba16float`; SSR is `rgba16float`). |
| `bgra8unorm-storage` | **not requested** | — | No compute pass writes the swapchain. |
| `shader-f16` / `subgroups` / `subgroups-f16` | **not requested** | — | No pass has an f16 or subgroup variant yet (FDTD fields and the IBL GGX bake are f32 / plain loops). Request only alongside the WGSL path that uses it, gated off `compatibility` and software adapters. |
| `timestamp-query-inside-passes` | **not requested** | — | Profiler scopes are pass-boundary only. |
| `float32-blendable` | **not requested** | — | No blended f32 target; the bloom upsample blends into `rg11b10ufloat` / `rgba16float`, both blendable in core. |

Missing features are skipped and logged; init does not fail.

## Preferred limits (soft)

`WebGPUManager.negotiateLimits()` requests a limit **only if** `adapter.limits[key] >= preferred`.
`PREFERRED_LIMITS` (`webgpu-init/adapter.ts`) is **empty**: every limit the renderer depends on fits the WebGPU core defaults, and asking for more than a pass uses only narrows the set of adapters that boot (#171).

| Limit | Core default | Renderer peak | Requested? |
|-------|-------------|---------------|-----------|
| `maxStorageBuffersPerShaderStage` | 8 | 4 (`fdtdSlice` F, `fdtdCompute` C) | No — was 10 before #223, more than any layout used |
| `maxUniformBuffersPerShaderStage` | 12 | 4 (`segEnhanced` F) | No |
| `maxSampledTexturesPerShaderStage` | 16 | 5 (`bloomComposite` F) | No |
| `maxStorageTexturesPerShaderStage` | 4 | 1 (`ssr` C) | No |
| `maxComputeWorkgroupStorageSize`, `maxBufferSize`, `maxStorageBufferBindingSize`, `maxComputeInvocationsPerWorkgroup` | 16 KiB, 256 MiB, 128 MiB, 256 | ≤ default | No — the old preferred values *were* the defaults |
| `maxColorAttachmentBytesPerSample` | 32 | 10 (`rgba16float` scene + `rg8unorm` G-buffer) | *computed* — only if the scene targets ever exceed 32 B/sample |

`npm run check:bindings` asserts the per-stage peaks from `bind-group-schema.json` stay under the core defaults, so a layout that outgrows one fails CI instead of `createBindGroupLayout` on every adapter at boot. Raise a preferred value only together with the shader that needs it.

### `maxColorAttachmentBytesPerSample`

The scene pass attaches scene color (float on the linear colour pipeline,
canvas format on `?color=legacy`) **plus** the `rg8unorm`
metalness/roughness G-buffer (ADR-0005 WS2). `sceneColorAttachmentLimit()`
prices those targets with `colorAttachmentBytesPerSample()`
(`src/color-attachment-cost.ts`, the spec's align-then-add rule) and returns a
limit request **only if** the total exceeds the guaranteed 32 B/sample default:

| Targets | Cost | Requested? |
|---------|------|-----------|
| `bgra8unorm` + `rg8unorm` (`?color=legacy`) | 4 → align 2 → +2 = **6 B** | No — fits the default |
| `rg11b10ufloat` + `rg8unorm` (linear) | 8 → align 2 → +2 = **10 B** | No |
| `rgba16float` + `rg8unorm` (linear, no rg11b10) | 8 → align 2 → +2 = **10 B** | No |
| e.g. `rgba32float` + `rgba16float` | **24 B** | No |

So the key is currently never requested — in line with #171's "never ask for
what no pass uses". It exists so that widening a target raises the request
automatically instead of failing pipeline validation on the first frame.
`negotiateLimits()` still drops the key on an adapter that cannot meet it, so a
low-end adapter gets a device rather than a `requestDevice` rejection;
`_checkColorAttachmentBudget()` then logs an error at init if the granted
budget is genuinely short. `npm run check:post` asserts every attachable format
is priced and that the scene pass still fits.

Note this is a **per-sample** figure: 4x MSAA does not multiply it.

Current particle compute uses workgroup size **64** — well within defaults on shipping browsers.

## Device lifecycle

### `device.lost`

- Handler attached in `WebGPUManager._attachDeviceHooks`.
- `reason: 'destroyed'` follows only our own `device.destroy()` (page
  teardown); the manager does **not** recover from it. A real GPU reset
  reports `'unknown'`. `window.simulateDeviceLost()` destroys the device
  *flagged as a test*, so recovery runs — use it to exercise this path.
- `MultiDeviceVisualizer` sets `onDeviceLost` to `recoverFromDeviceLoss`
  (`src/visualizer/init-methods.ts`) — a **session re-init**, not a reload:
  1. `WebGPUManager.reinit()` calls `requestPreferredAdapter()` again, then
     re-runs feature/limit negotiation and `requestDevice` on the **new**
     adapter. Re-using the old adapter is a spec error: an adapter is
     consumed by its first successful `requestDevice`, so recovery used to
     always end at the reload overlay. ADR-0007 forbids a second *live*
     device, not a fresh adapter after loss. Canvas context is reconfigured
     and depth/global-uniform state is rebuilt.
  2. `MultiDeviceVisualizer._bootGpuState()` — the GPU half of `init()`
     (pipeline cache, integration/profiler, IBL, shared geometry, devices,
     energy pipes, overview cull, floor/sky, bloom/TAA/SSR/depth-resolve/
     anomaly-wall, material table) — re-runs on the new device. The
     one-time DOM/session wiring in `init()` itself (canvas pointer
     listeners, hardware panel, resize observer, mock-hardware connect)
     does **not** re-run, so it is never double-registered.
  3. `LabSession` (plant/telemetry/operator state) and the module-level
     plant singletons it reads (`segOperator`, `segWasm`) are never touched
     by GPU re-init, so the sim keeps running at its current RPM through
     the outage instead of resetting to 0.
  4. The render loop no-ops (via `_deviceRecovering`) from the moment
     `device.lost` fires until the rebuild finishes, then resumes on its
     own next `requestAnimationFrame` tick — no explicit restart needed.
- If `WebGPUManager.reinit()` fails (no adapter on re-request) or the GPU
  state rebuild throws, `_deviceRecovering` stays `true` and the classic
  full-screen “WebGPU device lost” + **Reload page** overlay
  (`showDeviceLostUI`) is shown — same UI as before, now a fallback rather
  than the only path.
- Manual guard against duplicate array pushes across a second boot:
  `setupEnergyPipes()` resets `this.energyPipes = []` before rebuilding
  (the historical direct-`init()`-only assumption no longer holds once
  `_bootGpuState()` can run twice). `setupIblPrefilter()`'s
  `iblResources`/`iblCompute` memo guards and the lazily-built `fdtdSlice`/
  `overviewCull` passes are explicitly reset to their "not yet built"
  sentinel by `recoverFromDeviceLoss` before `_bootGpuState()` runs, since
  those are the only setup steps in the chain that skip rebuilding when
  the field is already non-null.

**Manual test:** DevTools → Sensors / `chrome://gpu` GPU process kill, or:

```js
// After app load (WebGPU path only)
window.simulateDeviceLost();
// Expect the canvas to keep rendering (brief pause) at the same RPM —
// the device-lost overlay only appears if adapter re-request also fails.
// (A bare device.destroy() reports reason 'destroyed' and is treated as
// teardown — no recovery.)
```

### `uncapturederror`

- Logged as `[WebGPU] uncapturederror: …` (validation / OOM / internal).
- Optional `onUncapturedError` callback on `WebGPUManager` options.

## GPU timing

Timestamps go on pass descriptors (`profiler.passTimestampWrites('begin' | 'end')`):
query 0 at the beginning of the `particle-compute` pass, query 1 at the end of
the composite pass. `GPUCommandEncoder.writeTimestamp` was removed from the
spec; calling it is what used to blank the canvas. Frames without a composite
pass skip the resolve, and a non-increasing pair is dropped rather than read as 0 ms.

1. Default: `timestamp-query` **not** requested → no query sets.
2. Profiling: load with `?gpuTiming=1` (reload required to re-request the feature).
3. In debug panel (F3), enable **GPU Timing** only after step 2.
4. Never auto-enable `profiler.timingEnabled` on init.

## Pipelines and bind groups

See **`docs/BINDINGS.md`**. Layouts live in `src/pipeline-layout-cache.ts`; devices do not call `layout: 'auto'`.
`npm run check:bindings` catches `@binding` drift between the FDTD/post layouts and their WGSL, before it surfaces as a runtime bind-group mismatch.

## Related files

- `src/webgpu-manager.ts` — device lifetime (`init` / `reinit`), global uniforms; static helpers delegate to `src/webgpu-init/` (`adapter.ts` negotiation, `canvas.ts` configure + sizing, `color-pipeline.ts` scene / post / canvas formats, `device-lost.ts` hooks). Scene depth belongs to the post stack (`src/visualizer/scene-post-buffers.ts`) — the manager's own unused depth texture was removed in #223  
- `src/pipeline-layout-cache.ts` — explicit layouts + shared pipelines  
- `src/performance-profiler.ts` — timing + tier (consumes adapter info)  
- `src/debug-panel.ts` — GPU timing toggle  
- `src/multi-device-visualizer.ts` — depth textures, render pass attachment  
- `src/device-pipeline-manager.ts` — attaches shared pipelines per device  

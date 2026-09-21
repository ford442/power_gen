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
| `WebGPUManager.reinit()` (device-lost recovery) | **No** — reuses the existing `GPUAdapter`, only re-requests the device |
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
| `format` | `navigator.gpu.getPreferredCanvasFormat()` | Platform preferred (`bgra8unorm` / `rgba8unorm`) |
| `alphaMode` | **`opaque`** | Full-viewport canvas; HTML overlays do not need canvas alpha (slight compositing win) |
| `colorSpace` | **`srgb`** default; **`display-p3`** if `?p3=1` | CI screenshots stay sRGB; P3 is opt-in for showroom metals |
| `toneMapping` | `{ mode: 'standard' }` default; `'extended'` if `?hdr=1` **and** `(dynamic-range: high)` | SDR composite ACES-maps to `[0,1]` (`filmicTonemap`). When `extended`, bloom composite sets `outputLinearHdr` and skips ACES so the canvas compositor is not double-tonemapped |
| `viewFormats` | preferred UNORM + `-srgb` sibling when it exists | Post/readback stay UNORM; sampling may reinterpret as sRGB |
| `usage` | `RENDER_ATTACHMENT \| COPY_SRC` | Present + optional readback/screenshots |

Scene color is **not** the swapchain (`bloomSceneTexture`). Do **not** set MSAA on `configure()`. Offscreen `sampleCount` is `1` via `WebGPUManager.offscreenColorDescriptor()` for the base scene/G-buffer textures; the ADR-0005 WS2 showroom MSAA path (`high` tier + focus mode) uses separate `sampleCount: 4` textures with manual color `resolveTarget` + a manual depth resolve — see "4x MSAA" in `docs/LIGHTING_RIG.md`.

Override: `new WebGPUManager(canvas, { alphaMode: 'premultiplied' })` if a future UI needs canvas alpha.

## Adapter request (`featureLevel`)

`WebGPUManager.requestPreferredAdapter()` (shared with the boot probe):

1. `{ powerPreference: 'high-performance', forceFallbackAdapter: false, featureLevel: 'core' }`
2. If that returns **null**, retry with `featureLevel: 'compatibility'` (Safari/Android).
3. If `featureLevel` throws (older Chromium), one legacy `requestAdapter` without the key.

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
| `timestamp-query` | **used** | URL has `?gpuTiming=1` | Default **off**. Writing timestamps into the main render encoder blanks the canvas on some D3D12/ANGLE stacks. Profiler keeps `timingEnabled = false` until the debug panel toggle. |
| `rg11b10ufloat-renderable` | **used** | Always if present | Bloom extract/blur intermediates (`bloomTempTexture`, `bloomBlurTexture`) via `WebGPUManager.bloomIntermediateFormat()`. Scene + prev-scene stay on the canvas format. |
| `texture-compression-bc` / `etc2` / `astc` | **used** | If the adapter supports them (skipped on fallback/software) | Requested at `requestDevice`. Stand GLB KTX2 albedo uploads BC1 / ASTC / ETC2 via `ktx2-gpu.ts`. F3 / `getRendererInfo().textureCompression` reports `bc` \| `etc2` \| `astc` \| `none`. |
| `float32-filterable` | **not requested** | — | No sampled `rgba32float` targets (bloom is `rg11b10`; SSR is `rgba16float`). |
| `bgra8unorm-storage` | **not requested** | — | No compute pass writes the swapchain. |

Missing features are skipped and logged; init does not fail.

## Preferred limits (soft)

`WebGPUManager.negotiateLimits()` requests a limit **only if** `adapter.limits[key] >= preferred`.  
Current soft targets (`PREFERRED_LIMITS` in `webgpu-manager.ts`):

| Limit | Preferred | Rationale |
|-------|-----------|-----------|
| `maxStorageBuffersPerShaderStage` | 10 | Headroom above common default (8) as particle/compute grows |
| `maxComputeWorkgroupStorageSize` | 16384 | Shared-memory headroom |
| `maxBufferSize` | 256 MiB | Large particle / field buffers |
| `maxStorageBufferBindingSize` | 128 MiB | Storage bind headroom |
| `maxComputeInvocationsPerWorkgroup` | 256 | Workgroup size flexibility |
| `maxColorAttachmentBytesPerSample` | *computed* | Scene pass color targets — **only when they exceed the 32 B/sample default** |

If the adapter cannot meet a preferred value, that key is **omitted** (device uses implementation defaults). Raise preferred values only when shaders require them.

### `maxColorAttachmentBytesPerSample`

The scene pass attaches canvas-format color **plus** the `rg8unorm`
metalness/roughness G-buffer (ADR-0005 WS2). `sceneColorAttachmentLimit()`
prices those targets with `colorAttachmentBytesPerSample()`
(`src/color-attachment-cost.ts`, the spec's align-then-add rule) and returns a
limit request **only if** the total exceeds the guaranteed 32 B/sample default:

| Targets | Cost | Requested? |
|---------|------|-----------|
| `bgra8unorm` + `rg8unorm` (today) | 4 → align 2 → +2 = **6 B** | No — fits the default |
| e.g. `bgra8unorm` + `rgba16float` | 4 → align 8 → +8 = **16 B** | No |
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
- `MultiDeviceVisualizer` sets `onDeviceLost` to `recoverFromDeviceLoss`
  (`src/visualizer/init-methods.ts`) — a **session re-init on the same
  adapter**, not a reload:
  1. `WebGPUManager.reinit()` re-runs feature/limit negotiation and calls
     `adapter.requestDevice` again on the existing `GPUAdapter` (ADR-0007 —
     still exactly one device; never a second `requestAdapter`). Canvas
     context is reconfigured and depth/global-uniform state is rebuilt.
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
- If `WebGPUManager.reinit()` fails (adapter itself is gone) or the GPU
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
window.multiVisualizer.webgpu.device.destroy();
// Expect the canvas to keep rendering (brief pause) at the same RPM —
// the device-lost overlay only appears if adapter re-request also fails.
```

### `uncapturederror`

- Logged as `[WebGPU] uncapturederror: …` (validation / OOM / internal).
- Optional `onUncapturedError` callback on `WebGPUManager` options.

## GPU timing (blank-canvas safeguard)

1. Default: `timestamp-query` **not** requested → no query sets → no blank canvas risk.
2. Profiling: load with `?gpuTiming=1` (reload required to re-request the feature).
3. In debug panel (F3), enable **GPU Timing** only after step 2.
4. Never auto-enable `profiler.timingEnabled` on init.

## Pipelines and bind groups

See **`docs/BINDINGS.md`**. Layouts live in `src/pipeline-layout-cache.ts`; devices do not call `layout: 'auto'`.
`npm run check:bindings` catches `@binding` drift between the FDTD/post layouts and their WGSL, before it surfaces as a runtime bind-group mismatch.

## Related files

- `src/webgpu-manager.ts` — adapter/device/canvas/depth hooks  
- `src/pipeline-layout-cache.ts` — explicit layouts + shared pipelines  
- `src/performance-profiler.ts` — timing + tier (consumes adapter info)  
- `src/debug-panel.ts` — GPU timing toggle  
- `src/multi-device-visualizer.ts` — depth textures, render pass attachment  
- `src/device-pipeline-manager.ts` — attaches shared pipelines per device  

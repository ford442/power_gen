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
| `PerformanceProfiler` | **No** — receives `{ adapter, adapterInfo }` from the manager |
| gpu-chores | **No** — adopts session device only |
| Debug / GPU tier | Uses profiler’s cached `adapterInfo` |

Do not open a WebGL2 context to “rescue” multi-device after probe failure.

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

If the adapter cannot meet a preferred value, that key is **omitted** (device uses implementation defaults). Raise preferred values only when shaders require them.

Current particle compute uses workgroup size **64** — well within defaults on shipping browsers.

## Device lifecycle

### `device.lost`

- Handler attached in `WebGPUManager._attachDeviceHooks`.
- Default UI: full-screen “WebGPU device lost” + **Reload page** (`showDeviceLostUI`).
- `MultiDeviceVisualizer` sets `onDeviceLost` to log + show that UI.
- Full multi-device re-init without reload is not attempted (pipelines/buffers would all need rebuild).

**Manual test:** DevTools → Sensors / `chrome://gpu` GPU process kill, or:

```js
// After app load (WebGPU path only)
window.multiVisualizer.webgpu.device.destroy();
// Expect device-lost overlay with Reload button
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

## Related files

- `src/webgpu-manager.ts` — adapter/device/canvas/depth hooks  
- `src/pipeline-layout-cache.ts` — explicit layouts + shared pipelines  
- `src/performance-profiler.ts` — timing + tier (consumes adapter info)  
- `src/debug-panel.ts` — GPU timing toggle  
- `src/multi-device-visualizer.ts` — depth textures, render pass attachment  
- `src/device-pipeline-manager.ts` — attaches shared pipelines per device  

# WebGPU device setup

Primary path: `src/webgpu-manager.js` → `MultiDeviceVisualizer`.  
Fallback: `src/renderers/webgl2/` (no WebGPU device).

## Single adapter request

| Who | Calls `requestAdapter`? |
|-----|-------------------------|
| `WebGPUManager.init()` | **Yes — once** (`powerPreference: "high-performance"`) |
| `PerformanceProfiler` | **No** — receives `{ adapter, adapterInfo }` from the manager |
| Debug / GPU tier | Uses profiler’s cached `adapterInfo` |

Never call `requestAdapter()` again for feature probing; pass the manager’s adapter/info.

## Canvas configuration

| Setting | Value | Why |
|---------|-------|-----|
| `format` | `navigator.gpu.getPreferredCanvasFormat()` | Platform preferred (`bgra8unorm` / `rgba8unorm`) |
| `alphaMode` | **`opaque`** | Full-viewport canvas; HTML overlays do not need canvas alpha (slight compositing win) |
| `usage` | `RENDER_ATTACHMENT \| COPY_SRC` | Present + optional readback/screenshots |

Override: `new WebGPUManager(canvas, { alphaMode: 'premultiplied' })` if a future UI needs canvas alpha.

## Depth format

| Setting | Value | Why |
|---------|-------|-----|
| Scene depth | **`depth24plus`** | Stencil unused; lower memory than `depth24plus-stencil8` |
| Pipelines | `visualizer.depthFormat` / `webgpu.depthFormat` | Single source of truth |
| Render pass | `WebGPUManager.depthStencilAttachment(view)` | Depth ops only — **no** stencil load/store on depth-only formats |

Bloom still samples depth via `createView({ aspect: 'depth-only' })`.

## Optional features (never hard-required)

Negotiated in `WebGPUManager.negotiateFeatures()` when the adapter supports them:

| Feature | When enabled | Notes |
|---------|----------------|-------|
| `timestamp-query` | **Only** if URL has `?gpuTiming=1` | Default **off**. Writing timestamps into the main render encoder blanks the canvas on some D3D12/ANGLE stacks (60 FPS, no validation errors). Even when requested, profiler keeps `timingEnabled = false` until the debug panel toggle. |
| `float32-filterable` | Always if present | Future float filterable textures |
| `texture-compression-bc` | Always if present | Reserved for compressed textures |
| `rg11b10ufloat-renderable` | Always if present | HDR intermediates if used later |
| `bgra8unorm-storage` | Always if present | Storage + canvas format interop |

Missing features are skipped and logged; init does not fail.

## Preferred limits (soft)

`WebGPUManager.negotiateLimits()` requests a limit **only if** `adapter.limits[key] >= preferred`.  
Current soft targets (`PREFERRED_LIMITS` in `webgpu-manager.js`):

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

See **`docs/BINDINGS.md`**. Layouts live in `src/pipeline-layout-cache.js`; devices do not call `layout: 'auto'`.

## Related files

- `src/webgpu-manager.js` — adapter/device/canvas/depth hooks  
- `src/pipeline-layout-cache.js` — explicit layouts + shared pipelines  
- `src/performance-profiler.js` — timing + tier (consumes adapter info)  
- `src/debug-panel.js` — GPU timing toggle  
- `src/multi-device-visualizer.js` — depth textures, render pass attachment  
- `src/device-pipeline-manager.js` — attaches shared pipelines per device  

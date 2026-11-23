# WebGL2 renderer (opt-in only — automatic fallback disabled)

Enable **only** with explicit `?renderer=webgl2` (or `setRenderer('webgl2')`).

**Default boot requires WebGPU.** If the WebGPU probe fails, the app **hard-fails**
and does **not** open a WebGL2 context (no dual-hot rescue). See
`src/renderers/webgpu-probe.ts`, `window.webgpuProbe`, and ADR-0001 / ADR-0007.

This path remains in-tree for **agents / CI / GPU-less VMs** that pass
`?renderer=webgl2` on purpose. It shares plant physics and telemetry with
WebGPU; it does **not** implement every WebGPU visual feature.

## What works (parity with operator workflow)

| Feature | Status |
|---------|--------|
| `SimRateController` substeps | Yes |
| `segOperator` START/STOP + drive | Yes → non-zero RPM/V/I/P |
| TelemetryHub publish each frame | Yes (same as WebGPU) |
| Mode buttons (`window.setMode`) | Yes — camera focus + device reset + hub view |
| SEG layout presets | Yes — roller orbit counts/radii from `seg-layout.ts` |
| `prototype` URL param | Yes — pole tint + Roschin layout when `lab` (shared `url-params.ts`) |
| `anomalousEffectsEnabled` | Yes — parsed from `prototype=lab`; toggle in debug panel (walls WebGPU-only) |
| Heron layout presets | Yes |
| Particle count slider | Yes (`setParticleCount`) |
| MHD Hartmann profile | Yes — the same timelines as WebGPU (`mhdParcelPosition`, the CPU twin of `posMhd`) and the same profile card; markers are tinted by `u/u(0)` ([`FLUIDS.md`](./FLUIDS.md#mhd-duct)) |
| `?wasmPhysics=1` plant | Yes — SEG/Heron/Kelvin/Solar via `segWasm` |
| Overview energy pipes | Yes — simplified **line-strip Bézier** arcs; shared `EnergyNetwork` budget clamp when `?energyCoupling=1` |
| Lab field coupling | Yes — `FieldNetwork` writes the coupled B into the plant before either backend steps, so `?fieldCoupling=1` behaves identically here and on WebGPU (ADR-0011) |
| Lab charge coupling | Yes — `ChargeNetwork` writes the Kelvin seed before either backend steps, and `LabSession` keeps the off-focus VdG charging, so `?chargeCoupling=1` behaves identically here and on WebGPU (ADR-0013) |
| `captureCanvasFrame()` | Yes — `{ width, height, pixels, view, flipY? }` |
| `getRendererInfo()` | Yes — fps, view, telemetry snapshot, gaps list, `chores` breadcrumbs |
| gpu-chores meters | Yes — WASM/JS `reduce_f32` (no WebGPU device; exclusive session) |
| Circuit Lab (#256, ADR-0018) | Yes — the wiring view, scope, meters and the overview cable (line-strip, flow ∝ port current) are renderer-independent, and the C++ solver runs whenever `sim_core.wasm` loaded, **including `?wasmPhysics=0`** (that flag picks the plant backend only). Without `sim_core.wasm` (badge "WASM failed") the wiring view is **read-only** with a "needs WASM" note — there is no TS solver ([`CIRCUIT.md`](./CIRCUIT.md)) |

## Intentional visual gaps vs WebGPU

Do **not** expect these under WebGL2:

| Gap | WebGPU location |
|-----|-----------------|
| Bloom / tonemap / previous-frame post; linear-HDR colour pipeline (`?color=`, `?renderScale=` are WebGPU-only — WebGL2 output is unchanged) | `setupBloomPipeline`, `webgpu-init/color-pipeline.ts` |
| RK4 magnetic flux line tracer | `fluxTracer` compute + segment billboards |
| Energy arc meshes between rollers | `energyArc` pipeline |
| SEG enhanced PBR + UV materials | `segEnhanced` shaders |
| Roschin–Godin magnetic wall shells | `renderAnomalyWalls` |
| Full energy-pipe **particle** billboards | `EnergyPipe` + WGSL (WebGL2 uses lines) |
| GPU timestamp queries | `?gpuTiming=1` |
| Key-light shadow map (focus, `high` tier) | `visualizer/shadow-map.ts` + `common/shadow-pcf.wgsl` — **skipped**; WebGL2 keeps its unshadowed rig (`intentionalGaps`: `key-light shadow map`) |
| **Temporal AA** | `passes/taa-resolve.wgsl` — **skipped**, see below |
| **FDTD wave slice** (pulse-coil focus) | `passes/fdtd-tmz-compute.wgsl` + `fdtd-slice.wgsl` — GPU panel **skipped**; a CPU micro-grid readout stands in, see below (ADR-0010/0012) |
| Hardware bridge / electromagnet coils | CPU twin + panel work on WebGL2 (`?mockHardware=1`); **coil GPU viz** is WebGPU-only |
| **Field volume** (ADR-0017): volume field lines, slice arrows / LIC, \|B\| isosurfaces, charged particles | `visualizer/field-volume-pass.ts` — **skipped**; the field panel's probe readout and a CPU \|B\| slice (32² exact samples, same colour ramp) stand in (`intentionalGaps`) |
| **glTF CAD props** (housing, coil former, …) | `setup-gltf.ts` / `prop-registry.ts` — **skipped** (see below) |
| **Liquid solver** (MLS-MPM, ADR-0022) — Heron's jet as a liquid, and its screen-space surface | `fluids/*`, `visualizer/heron-liquid-pass.ts`, `visualizer/fluid-surface-pass.ts` — **WebGPU only** (compute + atomics). Heron's droplets here are ballistic in SI (plant exit speed, `g` over the bench scale, no drag, no interaction), the bench says so in a note, and `heronJetHeightM` reads 0 ("not measured") — [`FLUIDS.md`](./FLUIDS.md) |

### FDTD wave slice → CPU micro-grid readout

The WebGPU slice is a compute pass plus a scene-pass quad; neither has a cheap
GLSL equivalent worth maintaining, so ADR-0010 skipped it here entirely. That
left the fallback with no answer to the one thing the slice teaches, so
[ADR-0012](./adr/0012-fdtd-materials.md) runs the **same CPU kernel** instead:

| | WebGPU panel | WebGL2 readout |
|---|---|---|
| Grid | 256², GPU storage buffers | **64²** on the main thread: `FdtdTmzGrid` (TS), or the C++ kernel under `?wasmPhysics=1` |
| Steps / frame | 6 | 2 (front still crosses in ~1 s) |
| Materials | μ_r armature + σ turns | same map, same presets |
| Sources | same windings, world-placed | same windings, world-placed |
| Drive | coil current, or `?fdtdDrive=transformer` | **coil current only** — see below |
| Where | world-space quad in front of the coil | 176 px 2D canvas, bottom-left |
| Cost | a few ms of GPU | **0.23 ms/frame** of CPU (measured in `test:fdtd`) |

Under `?wasmPhysics=1`, once sim_core is loaded, the grid is the C++ kernel
(`cpp/src/plant/fdtd_tmz.cpp` via `physics/fdtd-tmz-wasm.ts`, #254 §5): same
update, same materials, Wasm SIMD. `window.fdtdHeatmapOverlay.stats().backend`
says which one runs. `npm run test:fdtd` holds the TS kernel, the WASM kernel and
the WGSL compute shader (executed from its own text on the CPU) to one another
within 1e-4 of the field peak; the TS kernel stays the reference and the default.

`?fdtdDrive=transformer` is **WebGPU-only**, and deliberately so. Borrowing
another bench's flux means keeping that bench's plant stepping while the pulse
coil is focused, because the render loop skips `update()` for every unfocused
device — the WebGPU path does that explicitly
(`MultiDeviceVisualizer._stepBorrowedDrivePlant`). This overlay only subscribes to
`TelemetryHub` and owns no device instances, so it cannot; honouring the flag here
would draw a drive frozen at 0. It always uses the pulse coil's own current.

It is a **readout, not a render path**: no GL state, no shader, and no contact
with `WebGL2MultiDeviceVisualizer` beyond a `TelemetryHub` subscription. Gated to
pulse-coil focus, and `?fdtd=0` kills it like the GPU panel (nothing is even
mounted). It sits **bottom-left**, above the mode label: the bottom-right corner
belongs to `#tachometer`, and an RPM readout matters more than a wave picture.
`pointer-events: none`, so it never eats a camera drag.

Agent / e2e hooks on `window.fdtdHeatmapOverlay`:

| Member | Use |
|--------|-----|
| `stats()` | `{ active, steps, peakEz, finite, hasMaterials, drive }` — tells a live panel from a blank rectangle |
| `driveTarget` | Force the drive without running the plant, then watch it propagate |
| `step()` | Advance one frame by hand |

Host: `src/fdtd-heatmap-overlay.ts`. Covered by two e2e tests (hidden outside
focus / visible and clear of the tachometer in it; `?fdtd=0` mounts nothing).

### Temporal AA

TAA is **WebGPU-only** and deliberately not ported. It needs a history target,
a per-frame reprojection against the previous view-projection, and a resolve
pass slotted between the scene and bloom — none of which the WebGL2 path has,
since it has no bloom stack to slot into in the first place (see the row above).
`?taa=0` is accepted and ignored on WebGL2.

Neither does WebGL2 need `preserveDrawingBuffer` for it: TAA keeps its history
in an offscreen texture, so the documented context attributes
(`alpha: false`, `antialias: true`, `stencil: false`, `preserveDrawingBuffer`
only for capture) are unchanged. WebGL2 keeps relying on the driver's MSAA
(`antialias: true`) for edge quality.

## glTF / CAD props (skipped or reduced LOD)

WebGL2 does **not** decode or draw glTF/GLB CAD props. Reasons:

- Heavy GLB parse + GPU upload is costly on the agent / CI / integrated-GPU path.
- WebGL2 already uses procedural `seg-frame-model` for the lab bench / stand silhouette.
- ADR-0005 keeps overview light; second+ CAD props are focus-only even on WebGPU.

| Asset | WebGPU | WebGL2 |
|-------|--------|--------|
| Housing shell GLB | SEG focus (`loadPolicy: resident`) | Skip — procedural frame |
| Coil former GLB | SEG focus only (`loadPolicy: focus`, dispose on leave) | Skip |
| Stand / base plate GLB | SEG focus only (`loadPolicy: focus`, dispose on leave) | Skip |
| Reduced LOD GLBs | Optional later (`*-lod.glb`) | Prefer skip; if ever enabled, load `*-lod` only |

Disable WebGPU CAD: `?gltfHousing=0`. Coil former only: `?gltfCoilFormer=0`. Stand: `?gltfStand=0`. Base plate: `?gltfBasePlate=0`.

When artist CAD exceeds the soft ~50 KB placeholder budget, WebGL2 should continue to **skip** or load a dedicated reduced LOD — never the full showroom mesh. Document any new LOD file next to the master GLB in `docs/GLTF_ASSETS.md`.

## CI / agent hooks

```js
// Switch mode and wait a few frames, then:
const info = window.getRendererInfo();
// info.renderer === 'webgl2'
// info.telemetry.rpm after START
// info.intentionalGaps — documented gaps

const frame = window.captureCanvasFrame({ flipY: true });
// frame.pixels — RGBA8 Uint8Array, origin top-left if flipY
// frame.view — current focused mode
```

Debug keys (WebGL2 only): `W` wireframe, `P` particle debug, `N` normals,
`Space` pause, `.` step, `[` / `]` slow-mo.

Both hooks exist on WebGPU too since #258 (`getRendererInfo().renderer ===
'webgpu'`; `captureCanvasFrame` renders one frame on demand there).

## Measured parity with WebGPU

`e2e/baselines.webgpu.js` captures the same six frozen views on both
renderers (`?seed=1&taa=0`, scene time held at 8 s, particles left out,
520×566, both on SwiftShader) and compares the frames with pixelmatch. This
is a measurement, never a gate: the renderers differ by design (the gaps
above), and both sides are software-rasterised frames — WebGPU at its `low`
tier, without IBL or SSR. First numbers, 2026-11-22:

| View | Pixels differing | Mean abs. channel difference (0–255) |
|---|---|---|
| SEG focus, studio | 71.5 % | 76.7 |
| SEG focus, lab | 69.8 % | 69.1 |
| SEG focus, drama | 76.1 % | 80.6 |
| overview | 78.9 % | 114.6 |
| transformer | 15.9 % | 29.6 |
| heron | 36.0 % | 52.0 |

What the pictures behind the SEG and overview numbers show
(`e2e/baselines/{webgpu,webgl2}-swiftshader/`):

- **Exposure.** The WebGPU frames are much brighter and less saturated than
  the WebGL2 ones (overview's foreground cylinders are near white on WebGPU,
  saturated red / green on WebGL2).
- **SEG rollers.** On WebGPU the rollers lie at assorted tilts; on WebGL2
  they stand upright on their rings. The WebGPU instance buffer comes from
  `seg-roller-compute.wgsl`, whose rolling quaternion turns each roller about
  the orbit tangent.
- **SEG framing.** In SEG focus WebGL2 draws the CAD housing and base plate
  large in frame; WebGPU shows the bench from further back.

Whether the first two also show on a hardware GPU is not known from these
captures. The report CI uploads (`webgpu-baseline-report` → `parity/`) has
the per-view diff images; rerun `npm run test:e2e:webgpu` to refresh the
table after a rendering change.

## Context attributes

`WebGL2Context.init()` uses:

| Option | Value | Why |
|--------|-------|-----|
| `alpha` | `false` | Matches WebGPU `opaque` |
| `antialias` | `true` | Cheap MSAA on this path. WebGPU has no implicit canvas MSAA — **do not** disable for “parity” |
| `depth` | `true` | Matches depth buffer |
| `stencil` | `false` | Matches `depth24plus` (no stencil) |
| `premultipliedAlpha` | `true` | HTML overlay compositing |
| `powerPreference` | `'high-performance'` (`'low-power'` with `?gpuPower=low`) | Same intent as WebGPU |
| `failIfMajorPerformanceCaveat` | `false` | SwiftShader / agent VMs must still boot |
| `preserveDrawingBuffer` | **`false`** unless `navigator.webdriver` or `?capture=1` | Playwright `captureCanvasFrame` / `readPixels`; default-off saves GPU memory for humans |

`EXT_texture_filter_anisotropic` is queried at init: `ctx.maxAnisotropy` is
`min(8, MAX_TEXTURE_MAX_ANISOTROPY_EXT)` (0 when missing) and
`ctx.applyAnisotropy(target)` sets it on the bound texture — a no-op without
the extension. The fallback has no glTF and no sampled textures today; this is
for mipmapped procedural textures only.

Depth textures are core in WebGL2, so `WEBGL_depth_texture` (a WebGL1
extension that always returns null here) is not requested.

**Context loss:** `webglcontextlost` calls `preventDefault()`, sets
`ctx.contextLost`, and shows the same reload overlay as WebGPU device loss,
titled "WebGL2 context lost". This path has no resource rebuild, so
`webglcontextrestored` still asks for a reload. E2E: "WebGL2 context loss shows
the reload overlay…" (uses `WEBGL_lose_context`).

## Architecture

```
WebGL2MultiDeviceVisualizer
  ├── SimRateController + segOperator (+ optional segWasm)
  ├── device-physics.js / particle-physics.js  (shared/)
  ├── telemetryHub.publishFrame
  ├── MeshRenderer / ParticleRenderer / SkyGrid
  └── EnergyPipeRenderer  (line strips, overview only)
```

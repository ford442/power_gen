# WebGL2 fallback renderer

Enable: `?renderer=webgl2` (or `setRenderer('webgl2')`).

This path is the **agent / CI / GPU-less VM** visualizer. It shares plant physics
and telemetry with WebGPU; it does **not** implement every WebGPU visual feature.

## What works (parity with operator workflow)

| Feature | Status |
|---------|--------|
| `SimRateController` substeps | Yes |
| `segOperator` START/STOP + drive | Yes → non-zero RPM/V/I/P |
| TelemetryHub publish each frame | Yes (same as WebGPU) |
| Mode buttons (`window.setMode`) | Yes — camera focus + device reset + hub view |
| SEG layout presets | Yes — roller orbit counts/radii from `seg-layout.js` |
| `prototype` URL param | Yes — pole tint + Roschin layout when `lab` (shared `url-params.js`) |
| `anomalousEffectsEnabled` | Yes — parsed from `prototype=lab`; toggle in debug panel (walls WebGPU-only) |
| Heron layout presets | Yes |
| Particle count slider | Yes (`setParticleCount`) |
| `?wasmPhysics=1` plant | Yes — SEG/Heron/Kelvin/Solar via `segWasm` |
| Overview energy pipes | Yes — simplified **line-strip Bézier** arcs; shared `EnergyNetwork` budget clamp when `?energyCoupling=1` |
| `captureCanvasFrame()` | Yes — `{ width, height, pixels, view, flipY? }` |
| `getRendererInfo()` | Yes — fps, view, telemetry snapshot, gaps list |

## Intentional visual gaps vs WebGPU

Do **not** expect these under WebGL2:

| Gap | WebGPU location |
|-----|-----------------|
| Bloom / tonemap / previous-frame post | `setupBloomPipeline` |
| RK4 magnetic flux line tracer | `fluxTracer` compute + segment billboards |
| Energy arc meshes between rollers | `energyArc` pipeline |
| SEG enhanced PBR + UV materials | `segEnhanced` shaders |
| Roschin–Godin magnetic wall shells | `renderAnomalyWalls` |
| Full energy-pipe **particle** billboards | `EnergyPipe` + WGSL (WebGL2 uses lines) |
| GPU timestamp queries | `?gpuTiming=1` |
| Hardware bridge / electromagnet coils | WebGPU-only hooks |
| **glTF CAD props** (housing, coil former, …) | `setup-gltf.js` / `prop-registry.js` — **skipped** (see below) |

## glTF / CAD props (skipped or reduced LOD)

WebGL2 does **not** decode or draw glTF/GLB CAD props. Reasons:

- Heavy GLB parse + GPU upload is costly on the agent / CI / integrated-GPU path.
- WebGL2 already uses procedural `seg-frame-model` for the lab bench / stand silhouette.
- ADR-0005 keeps overview light; second+ CAD props are focus-only even on WebGPU.

| Asset | WebGPU | WebGL2 |
|-------|--------|--------|
| Housing shell GLB | SEG focus (`loadPolicy: resident`) | Skip — procedural frame |
| Coil former GLB | SEG focus only (`loadPolicy: focus`, dispose on leave) | Skip |
| Future stand / base plate | Registry placeholders | Skip |
| Reduced LOD GLBs | Optional later (`*-lod.glb`) | Prefer skip; if ever enabled, load `*-lod` only |

Disable WebGPU CAD: `?gltfHousing=0`. Coil former only: `?gltfCoilFormer=0`.

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

## Architecture

```
WebGL2MultiDeviceVisualizer
  ├── SimRateController + segOperator (+ optional segWasm)
  ├── device-physics.js / particle-physics.js  (shared/)
  ├── telemetryHub.publishFrame
  ├── MeshRenderer / ParticleRenderer / SkyGrid
  └── EnergyPipeRenderer  (line strips, overview only)
```

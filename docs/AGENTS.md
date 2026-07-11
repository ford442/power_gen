<!-- From: /root/power_gen/AGENTS.md -->
# SEG WebGPU Visualizer - Agent Guide

## Project Overview

This is a **SEG (Searl Effect Generator) WebGPU Visualizer** - a real-time 3D simulation that runs in the browser using the WebGPU API. It visualizes four different physics phenomena:

1. **Searl Effect Generator (SEG)**: 3 concentric rings of magnetic rollers (12/22/32 rollers) in a toroidal formation with spiral energy flux patterns
2. **Heron's Fountain**: Fluid dynamics simulation with siphon-driven water jets
3. **Kelvin's Thunderstorm**: Electrostatic induction simulation with falling charged droplets
4. **LEDs + Solar Cells**: Photons traveling from LED array to solar panel with battery charge/discharge cycling

**Live Demo**: https://ford442.github.io/power_gen/

## Technology Stack

- **WebGPU API**: Modern GPU compute and graphics API (requires Chrome/Edge 113+)
- **JavaScript (ES modules)**: Core visualizer architecture
- **TypeScript**: Physics calculations, Wolfram MCP integration, and scientific UI layer
- **Vite**: Build tool for development and production bundling
- **WGSL**: WebGPU Shading Language for GPU shaders
- **Python 3 + Paramiko**: For SFTP deployment to remote servers
- **GitHub Pages**: For static hosting and CI/CD deployment

## Project Structure

Vite root is `src/` (see `vite.config.js`). There is **one** application architecture —
no root-level parallel tree and no legacy `SEGVisualizer` class.

```
/root/power_gen/
├── src/                              # Application source (Vite root)
│   ├── index.html                    # Multi-device dashboard UI
│   ├── main.js                       # Bootstrap: renderer select, window API, control wiring
│   ├── multi-device-visualizer.js    # WebGPU orchestrator (MultiDeviceVisualizer)
│   ├── multi-device-camera.js
│   ├── multi-device-shaders.js       # Inline WGSL getters for multi-device path
│   ├── webgpu-manager.js             # Adapter / device / canvas / depth
│   ├── camera-controller.js          # Orbital camera
│   ├── device-instance.js            # Per-device state + geometry/pipeline hooks
│   ├── device-geometry.js
│   ├── device-pipeline-manager.js
│   ├── device-uniforms.js
│   ├── device-compute.js
│   ├── device-mesh-layouts.js
│   ├── devices/                      # Setup / update / render helpers
│   ├── energy-pipe.js
│   ├── performance-profiler.js
│   ├── debug-panel.js
│   ├── scientific-data.js
│   ├── scientific-ui.js / scientific-ui/  # Gauges and scientific overlay
│   ├── seg-*.js                      # SEG layout, materials, operator panel, diagram
│   ├── heron-layout.js
│   ├── renderers/
│   │   ├── renderer-selector.js      # ?renderer=webgpu|webgl2 resolution
│   │   ├── shared/                  # CPU physics + primitive geometry (both backends)
│   │   │   ├── device-physics.js
│   │   │   ├── particle-physics.js
│   │   │   ├── primitive-geometry.js
│   │   │   └── device-view.js
│   │   └── webgl2/                   # WebGL2MultiDeviceVisualizer + GLSL
│   ├── shaders/                      # WGSL (+ generators/ for multi-device)
│   ├── wasm/                         # Emscripten sim_core bridge (optional RK4)
│   ├── integration.ts                # SEGIntegrationManager (TS physics / UI hub)
│   ├── ValidatedConstants.ts
│   ├── fallback-physics.ts
│   └── public/wasm/                  # Prebuilt sim_core.js / .wasm
│
├── package.json
├── vite.config.js                    # root=src, outDir=../dist
├── tsconfig.json
├── deploy.py
├── .github/workflows/static.yml      # build:site → Pages
├── docs/AGENTS.md                    # This file
├── claude.md
└── README.md
```

### Architecture (single source of truth)

| Path | Entry | Backend |
|------|-------|---------|
| Primary | `src/main.js` → `MultiDeviceVisualizer` | WebGPU (`webgpu-manager.js`) |
| Fallback | `src/main.js` → `WebGL2MultiDeviceVisualizer` | WebGL2 (`renderers/webgl2/`) |

**Bootstrap:** `bootstrapVisualizer()` uses `resolveRenderer()` (`?renderer=`,
`localStorage seg-renderer`, `window.DEBUG_RENDERER`, or `navigator.gpu`). Prefer
WebGPU; fall back to WebGL2. There is no third legacy visualizer.

**Shared simulation:** CPU physics and mesh primitives live in `renderers/shared/`
and are used by both backends. GPU particle integration for WebGPU is in
`shaders/compute.wgsl` / shader generators; WebGL2 uses `particle-physics.js`.

**`src/main.js` responsibilities only:** renderer bootstrap, `window.*` control API
(mode, SEG/Heron layouts, lighting, frame level), WASM badge/benchmark wiring,
operator panel + 2D diagram init. Geometry, pipelines, and the frame loop live
elsewhere.

**Telemetry:** one write path via `src/telemetry-hub.js` (`publishFrame` from
WebGPU or WebGL2 after physics). Operator panel and scientific gauges subscribe.
See **`docs/TELEMETRY.md`**.

### Language ownership (JS vs TypeScript)

| Layer | Language | Paths | Notes |
|-------|----------|-------|-------|
| Physics constants & formulas | **TypeScript** | `ValidatedConstants.ts`, `fallback-physics.ts`, `scientific-data.js` (legacy JS data), `led-solar-constants.ts` | Authoritative numeric sources + uncertainty metadata |
| Integration / protocol types | **TypeScript** | `types.ts`, `integration.ts`, `mcp-manager.ts`, `led-solar-integration.ts`, `index.ts` | `SEGIntegrationManager` owns typed physics uniforms |
| WASM bridge | **TypeScript** (+ thin JS) | `wasm/sim.ts`, `wasm/types.ts`, `wasm/index.ts`, `wasm/seg-physics-bridge.js` | Embind API + optional debug toggle |
| Bootstrap & dashboard wiring | **JavaScript** | `main.js`, `index.html` | No simulation logic |
| WebGPU / WebGL2 orchestration | **JavaScript** (gradual TS later) | `multi-device-visualizer.js`, `webgpu-manager.js`, `device-*.js`, `renderers/**` | Vite imports TS physics modules directly |
| Shared CPU sim (both backends) | **JavaScript** | `renderers/shared/*` | Imports `ValidatedConstants` from TS |

**Rules of thumb**
- New physics math, buffer layouts, and public numeric APIs → **TypeScript**.
- New render passes, geometry buffers, and UI wiring → **JavaScript** until a module is migrated.
- `npm run typecheck` checks **only** `src/**/*.ts` (`allowJs: false`). JS is not typechecked in CI.
- Optional `// @ts-check` on individual managers is allowed but not required.
- Runtime entry is `main.js`; `index.ts` is a **barrel** for typed exports, not the app entry.

**Multi-device typed physics**
- After WebGPU init, `MultiDeviceVisualizer` constructs `SEGIntegrationManager`
  (`enableScientificOverlay: false` so dashboard telemetry stays the sole UI).
- Each frame: `syncFromVisualizer(...)` → `update(dtMs)` → `writeUniformsToBuffer()`.
- Consumers: `visualizer.integration`, `visualizer.physicsUniformBuffer`
  (96-byte UNIFORM), or `window.SEGIntegration.manager`.
- Layout: see `PHYSICS_UNIFORM_FLOAT_COUNT` / `getPhysicsUniformArray()` in `integration.ts`.

**Typecheck / CI / builds**
```bash
npm run typecheck    # tsc --noEmit (requires @webgpu/types)
npm run validate     # typecheck + native C++ smoke + WGSL (naga if present)
npm run build:site   # Vite → dist/ (uses committed WASM; no Emscripten)
npm run build        # wasm:build then build:site (requires emcc or EMSDK)
npm run wasm:build   # scripts/build-wasm.sh — PATH emcc or $EMSDK
npm run wasm:native  # g++ smoke test, no Emscripten
npm run check:wgsl   # naga on standalone src/shaders/*.wgsl
```
- Pages deploy (`.github/workflows/static.yml`): typecheck + `build:site`
- Validation (`.github/workflows/validate.yml`): typecheck, site build, native C++, WGSL
- WASM rebuild (`.github/workflows/build-wasm.yml`): native smoke + `scripts/build-wasm.sh`

## Key Files Explained

### Application core (`src/`)

#### `main.js` (~300 lines)
Bootstrap only: imports visualizers, selects WebGPU vs WebGL2, exposes window APIs
for dashboard controls, initializes WASM status and SEG operator / 2D diagram UI.

#### `multi-device-visualizer.js` (~2000 lines)
The WebGPU orchestrator. `MultiDeviceVisualizer` class:
- Initializes `WebGPUManager`, `CameraController`, `PerformanceProfiler`, `DebugPanel`
- Attaches `SEGIntegrationManager` for typed physics uniforms each frame
- Manages device instances (seg, heron, kelvin, solar, peltier, mhd) via `DeviceInstance`
- Sets up energy pipes connecting devices in a cycle: SEG→Heron→Kelvin→SEG
- Renders a floor grid
- Handles view switching (overview, per-device focus)
- Runs the render loop with FPS counter
- Auto-quality adjustment based on GPU tier and frame rate

#### `webgpu-manager.js`
`WebGPUManager` class — **single** `requestAdapter` path for the app:
- Adapter: `powerPreference: "high-performance"`; info logged once
- Device: optional features (`float32-filterable`, etc.); `timestamp-query` only with `?gpuTiming=1`
- Soft `requiredLimits` from preferred caps when the adapter allows
- Canvas: preferred format, `alphaMode: 'opaque'`, `RENDER_ATTACHMENT | COPY_SRC`
- Depth: **`depth24plus`** (no stencil); see `DEPTH_FORMAT` / `depthStencilAttachment()`
- `device.lost` → reload UI; `uncapturederror` logged
- Passes `adapter` / `adapterInfo` into `PerformanceProfiler` (no second adapter request)

Full feature/limit matrix: **`docs/WEBGPU.md`**.

#### `pipeline-layout-cache.js`
Explicit `GPUBindGroupLayout` / `GPUPipelineLayout` factory and **shared** pipeline cache:
- No production `layout: 'auto'`
- Bind groups via `pipelineCache.createBindGroup(name, entries)`
- Device pipelines compiled once, reused by all `DeviceInstance`s
- Binding numbers: **`docs/BINDINGS.md`**

#### `camera-controller.js` (~151 lines)
`CameraController` class:
- Orbital camera: mouse drag to rotate, scroll to zoom
- Supports overview mode and per-device focus modes
- Smooth position interpolation

#### `device-instance.js` (~751 lines)
`DeviceInstance` class:
- Per-device state management (position, rotation, particle count, battery charge)
- Creates device uniform buffers, material buffers, and core material buffers
- Updates device state each frame (including battery drain/gain for solar device)
- Delegates geometry to `DeviceGeometry` and pipelines to `DevicePipelineManager`
- Supports RK4 flux-line visualization and energy arc visualization for SEG

#### `device-geometry.js` (~252 lines)
`DeviceGeometry` class:
- Generates cylinder geometry for rollers
- Generates sphere geometry for cores
- Creates particle buffers (position + phase seed as vec4f)
- Creates RK4 flux-segment buffers for SEG magnetic field lines
- Creates arc segment buffers for energy arcs
- Initializes SEG-specific geometry (base plate, stator rings, wiring, ring-separator plates, outer coil)

#### `device-pipeline-manager.js` (~104 lines)
`DevicePipelineManager` class:
- Creates roller render pipelines, particle pipelines, core pipelines
- Creates RK4 flux-line pipelines and energy arc pipelines for SEG
- Uses `layout: 'auto'` for simplicity

#### `energy-pipe.js` (~21 lines)
`EnergyPipe` class:
- Visualizes energy transfer between devices
- Configurable source, destination, and animation speed

#### `performance-profiler.js` (~400 lines)
`PerformanceProfiler` class:
- FPS history tracking (3600 samples)
- GPU timestamp queries (if supported)
- Buffer and texture memory tracking
- Shader compilation time tracking
- Auto-quality system: scales particle count to maintain 45+ FPS
- GPU tier detection (high/medium/low/unknown) based on vendor and architecture
- Benchmark mode

#### `debug-panel.js` (~489 lines)
`DebugPanel` class:
- Toggleable overlay (F3 or Ctrl+D)
- Displays FPS, GPU time, frame time
- Shows memory usage (buffers, textures)
- Shows active device list and particle counts
- Shows GPU tier and recommended settings
- Shows WebGPU adapter info

#### `scientific-data.js` (~636 lines)
Exports Wolfram-derived physics data as ES modules:
- `PHYSICAL_CONSTANTS` (CODATA 2018)
- `SEG_DATA` (magnet specs, B-field values, energy density, forces)
- `KELVIN_DATA` (capacitance, droplet charge, voltage buildup)
- `HERON_DATA` (SPH parameters, Tait EOS, flow rates)
- `MICROVOLT_DATA` (thermal noise, single-electron effects)
- `UNIFIED_PHYSICS_WGSL` (combined shader constants string)

### Dashboard and scientific UI

#### `src/index.html`
Multi-device dashboard:
- Header with status / FPS / WASM badge
- Left sidebar: power controls, drive parameters, mode buttons, layout presets, particle slider
- Center: fullscreen canvas (`#gpuCanvas`)
- Right panel: telemetry gauges
- Footer: mode and battery status
- Entry: `<script type="module" src="/main.js">` (Vite root = `src/`)

#### `src/scientific-ui.js` + `src/scientific-ui/`
Scientific UI components:
- `ScientificUIManager`: Main panel controller (collapsible, Ctrl+Shift+S toggle)
- `MagneticFieldGauge`: Circular gauge (0-3 Tesla) with color zones
- `EnergyDensityGauge`: Gauge for energy density
- `TorqueGauge`: Gauge for torque readings
- `ParticleFluxGauge`: Gauge for particle flux
- `WolframStatusPanel`: MCP connection status indicator
- `BatteryGauge`: Battery charge visualization
- `SolarPanelGauge`: Solar output visualization
- `LEDArrayGauge`: LED status display
- `EnergyBalanceDisplay`: Sankey-style energy flow diagram

### TypeScript Integration Layer (`src/*.ts`)

#### `src/types.ts` (~131 lines)
Core type definitions:
- Physics: `Vec3`, `MagneticFieldVector`, `SEGPhysicsState`
- MCP: `MCPStatus`, `WolframCacheEntry`, `WolframMCPState`, `WolframQueryOptions`
- Shader: `ShaderModule`, `ComputePipelineConfig`, `RenderPipelineConfig`
- Integration: `PhysicsConstants`, `SEGMagnetSpec`, `UncertaintyFlag`, `ValidationResult`

#### `src/ValidatedConstants.ts` (~239 lines)
Physics constants with metadata:
- `PHYSICAL_CONSTANTS` (CODATA 2018 values)
- `SEG_MAGNET` (NdFeB N52 specs)
- `SEG_CONFIG` (3-ring geometry)
- Individual exports with uncertainty flags (`MU_0`, `EPSILON_0`, `MAGNET_BR`, `MAGNETIC_MOMENT`)
- `getConstant()`, `areAllValidated()`, `getMaxUncertainty()`, `formatUncertainValue()`

#### `src/fallback-physics.ts` (~270 lines)
Analytical physics formulas when Wolfram MCP is unavailable:
- Dipole field, axial B-field, energy density, torque, adjacent roller force
- All functions return `UncertaintyFlag` with source and uncertainty percentage
- `UNCERTAINTY_LEVELS` constants: DIPOLE_FIELD ±5%, ENERGY_DENSITY ±2%, etc.
- `PHYSICAL_BOUNDS` for validation

#### `src/mcp-manager.ts` (~423 lines)
`WolframMCPManager` class:
- Caches queries in memory + `localStorage` persistence
- Fallback chain: cache → calculated fallback
- Exponential backoff for retries
- Default timeout: 5000ms, default TTL: 3600000ms (1 hour)
- Pre-populates common physics constants on initialization
- Simulated connection check (50% success rate for demo)

#### `src/integration.ts` (~649 lines)
`SEGIntegrationManager` class:
- Coordinates Wolfram MCP, scientific UI, physics state, shader uniforms
- Creates physics uniform buffer matching WGSL layout (64 bytes B-field params + 32 bytes material props)
- Includes a minimal `ScientificUIManager` that creates a floating HTML overlay
- Updates gauges with uncertainty indicators (✓ exact, ~ low, ≈ medium, ? high)

#### `src/led-solar-integration.ts` (~708 lines)
`LEDSolarSimulation` class:
- Complete LED/Solar/Battery system state management
- 6 LEDs in hex pattern (2 red, 2 green, 1 blue, 1 white)
- Solar panel with AM1.5G standard irradiance (1000 W/m²)
- Li-ion battery: 3.0V (0%) to 4.2V (100%)
- Real-time energy flow calculations with round-trip efficiency (~6.6%)
- `LEDSolarIntegration` connects to `SEGIntegrationManager`

#### `src/led-solar-constants.ts` (~416 lines)
- `LEDSolarConstants`, `LED_CONSTANTS`, `SOLAR_CONSTANTS`, `BATTERY_CONSTANTS`
- `IVCurveCalculator` for solar panel I-V curves
- `LEDSolarPhysics` for efficiency calculations

#### `src/index.ts` (~186 lines)
Central export module:
- Re-exports all types, constants, managers, and integration classes
- `VERSION = '1.0.0'`
- `initializeSEGIntegration(device, canvas)` helper
- Auto-attaches to `window.SEGIntegration` in browser

## Build and Development

### Vite Build Process

```bash
# Install dependencies
npm install

# Development server with hot reload (HTTPS localhost:5173)
npm run dev

# Production build (outputs to dist/)
npm run build

# Preview production build
npm run preview

# Build + SFTP deploy
npm run deploy
```

### Vite Configuration
- **Root**: `src/`
- **OutDir**: `../dist/`
- **EmptyOutDir**: true
- **Dev server**: HTTPS, host localhost, port 5173
- WGSL shaders imported as raw strings via `?raw` suffix

### Browser Requirements
- Chrome 113+ or Edge 113+
- WebGPU enabled (default in these versions)
- HTTPS or localhost context required

## Deployment

### GitHub Pages (Primary)

Automatic deployment on push to `main` branch via `.github/workflows/static.yml`:
- Runs `npm run build:site` (Vite → `dist/`)
- Uploads `dist/` as the Pages artifact
- URL: https://ford442.github.io/power_gen/

The workflow uses:
- `actions/checkout@v4`
- `actions/setup-node@v4` + `npm ci` + `npm run build:site`
- `actions/configure-pages@v5` (`enablement: true`)
- `actions/upload-pages-artifact@v3` (path: `dist`)
- `actions/deploy-pages@v4`

Enable Pages once: repo **Settings → Pages → Build and deployment → GitHub Actions**.

### Contabo bundle deploy (Secondary)

Manual deployment to remote storage via HTTPS API:

```bash
npm run build:site
export DEPLOY_TOKEN="your_token_from_vps"
python deploy.py
```

**Configuration in `deploy.py`**:
- Project: `powergen`
- API: `https://storage.noahcohn.com/api/deploy/...`
- Local source: `dist/` directory
- Token: `DEPLOY_TOKEN` environment variable only (no secrets in repo)

## Code Organization

### Main Classes

```javascript
class MultiDeviceVisualizer {
  webgpu: WebGPUManager        // Device/context management
  camera: CameraController     // Orbital camera
  profiler: PerformanceProfiler // FPS, GPU timing, auto-quality
  debugPanel: DebugPanel       // Toggleable debug overlay
  devices: Record<string, DeviceInstance> // seg, heron, kelvin, solar
  energyPipes: EnergyPipe[]    // Visual energy connections
  currentView: string          // 'overview' | 'seg' | 'heron' | 'kelvin' | 'solar'
  devicesEnabled: object       // Toggle per device
}
```

```javascript
class DeviceInstance {
  geometry: DeviceGeometry         // Buffers and mesh data
  pipelineManager: DevicePipelineManager // Render pipelines
  particleCount: number
  batteryCharge: number            // For solar device (0..1)
  position: [x, y, z]
  rotation: quaternion
}
```

### Shader Architecture

Shaders are written in WGSL and loaded via Vite `?raw` imports:

1. **`roller.wgsl`** (~476 lines): Vertex + fragment shader for device geometry
   - Transforms cylinders/spheres for all four modes
   - Instance-index conventions: 0-65 rollers, 66 core, 67 coil, 68-71 plates, 100-101 Kelvin rings, 200+ solar disc
   - Mode-specific materials: SEG metallic with green underglow, Heron steel/water, Kelvin copper with electrostatic shimmer, Solar LED warm glow + battery indicator
   - Fresnel and specular lighting driven by the real `cameraPos` uniform from the CPU (legacy fake orbiting camera removed)

2. **`particles.wgsl`** (~85 lines): Billboards particles as quads
   - Camera-facing orientation
   - Circular alpha blending

3. **`compute.wgsl`** (~133 lines): GPU compute physics
   - Workgroup size: 64
   - `posSEG()`: Spiral inward from outer ring, 3 full turns per cycle
   - `posHeron()`: Rising jet → falling arc → draining tube
   - `posKelvin()`: Falling droplets with wobble + spark discharge
   - `posSolar()`: Photons in straight lines from LEDs to solar panel

4. **`flux-lines.wgsl`** (~486 lines): Magnetic field line visualization for SEG. Generates clean, continuous toroidal helices around the three roller rings using the `traceBidirectional` compute entry point

5. **`magnetic-field.wgsl`** (~459 lines): Magnetic field calculation utilities

6. **`led-solar.wgsl`** (~1544 lines): LED/Solar specific shaders

7. **`multi-device-shaders.js`**: Inline WGSL getters for the multi-device WebGPU renderer
   - `segEnhancedVertShader` / `segEnhancedFragShader`: Default PBR path for SEG rollers, stator rings, wiring, and core plates (uses UV-bearing geometry from `seg-enhanced-geometry.js`)
   - `rollerVertShader` / `rollerFragShader`: Material fallback for the SEG base, solar battery gauge, and non-SEG device geometry
   - Prefer `shaders/generators/*` when editing; keep generators and any still-used `.wgsl` files in sync

### Mode System

Four simulation modes identified by numeric constants in shaders:
- `0.0` = SEG: 3 concentric rings (inner: 12 rollers @ radius 2.0, middle: 22 @ 4.0, outer: 32 @ 6.0)
- `1.0` = Heron's Fountain: Stacked vessels + connecting tubes
- `2.0` = Kelvin's Thunderstorm: Two symmetric drip can assemblies
- `3.0` = Solar/LED: 6 LED cylinders + battery + solar panel disc

### Uniform Buffer Layout

The compute shader expects this layout (JS writes as Float32Array):
```
[0-63]   viewProj: mat4x4f    (64 bytes - ignored by compute)
[64]     time: f32
[68]     mode: f32            (0=SEG, 1=Heron, 2=Kelvin, 3=Solar)
[72]     particleCount: f32
[76]     speedMult/batteryCharge: f32
```

## Scientific Data Integration

### Wolfram Alpha MCP
- All MCP queries timeout after 5 seconds
- Cache persists across page reloads (`localStorage`)
- Fallback values flagged with uncertainty indicators
- UI shows validated vs estimated values
- Exponential backoff for transient failures

### Physics Data Sources
Scientific constants verified by a 4-agent Wolfram swarm:
- **SEG**: B-field 0.705T surface, magnetic moment 5.635×10⁶ A·m², energy density 1.976×10⁶ J/m³
- **Kelvin**: Bucket capacitance 40.1 pF, voltage buildup 25 kV/s
- **Heron**: Tait gas constant 560,571 Pa, siphon velocity 4.43 m/s
- **Microvolt**: Thermal noise 0.129 μV RMS (1Hz, 1MΩ)

Full details in `WOLFRAM_DATA_SUMMARY.md`.

## Performance Notes

- Particle count per device: typically 1,000 to 20,000 (auto-quality may scale further)
- Workgroup size: 64 threads per compute dispatch
- Auto-quality: Drops particle multiplier to maintain 45+ FPS
- GPU tier detection: NVIDIA/AMD Ampere/RDNA3 = high, Intel = low
- Timestamp queries used when `timestamp-query` feature available
- Instanced rendering for rollers (single draw call per device)

## Code Style Guidelines

### JavaScript Style
- ES6+ class-based architecture
- Async/await for WebGPU initialization
- Single-letter variable names common in math-heavy sections (`t`, `p`, `cs`, `ss`)
- Minimal inline comments - code is often self-documenting via variable names
- Module imports use `.js` extension (Vite handles resolution)

### TypeScript Style
- Strict mode enabled
- Explicit return types on public methods
- Type aliases for physics quantities (`Vec3`, `MCPStatus`, etc.)
- Interface-based configuration objects

### WGSL Shader Style
- Type annotations explicit (`vec3f`, `mat4x4f`, `f32`)
- Binding and group attributes: `@binding(0) @group(0)`
- Entry points marked with `@vertex`, `@fragment`, `@compute`
- Workgroup size 64 for compute shaders
- Mode branching uses `< 0.5`, `< 1.5`, `< 2.5` pattern for float comparisons

## Testing

**No automated test suite exists.** Testing is manual:

1. Open `index.html` in Chrome/Edge 113+
2. Verify WebGPU initializes without error
3. Test all four mode buttons / device toggles
4. Adjust sliders for speed and particle count
5. Verify mouse interaction (drag to rotate, scroll to zoom)
6. Check FPS stays reasonable (target 60 FPS)
7. Test F3/Ctrl+D debug panel toggle
8. Test Ctrl+Shift+S scientific panel toggle
9. Verify energy pipes animate between devices

## Security Considerations

### Current Issues
- No input sanitization (not applicable for this static visualization)

### WebGPU Security
- WebGPU requires secure context (HTTPS or localhost)
- GPU memory access is sandboxed by browser
- No sensitive data processed in the application

### Recommendations
- Keep `DEPLOY_TOKEN` in environment variables or CI secrets only

## Future Extension Points

The codebase is designed for extension:
- `mode` system in shaders allows adding new physics simulations
- `DeviceInstance` pattern makes adding new device types straightforward
- `EnergyPipe` can connect any two devices
- WGSL utility functions in `src/shaders/` can be integrated into main pipelines
- Scientific UI gauges are modular and can be added/removed
- `PerformanceProfiler` auto-quality system adapts to new rendering loads

<!-- From: /root/power_gen/AGENTS.md -->
# SEG WebGPU Visualizer - Agent Guide

## Project Overview

This is a **SEG (Searl Effect Generator) WebGPU Visualizer** - a real-time 3D simulation that runs in the browser using the WebGPU API. It visualizes four different physics phenomena:

1. **Searl Effect Generator (SEG)**: 3 concentric rings of magnetic rollers (12/22/32 rollers) in a toroidal formation with spiral energy flux patterns
2. **Heron's Fountain**: Fluid dynamics simulation with siphon-driven water jets
3. **Kelvin's Thunderstorm**: Electrostatic induction simulation with falling charged droplets
4. **LEDs + Solar Cells**: Photons traveling from LED array to solar panel with battery charge/discharge cycling

**Live Demo**: https://ford442.github.io/seg-webgpu-visualizer/

## Technology Stack

- **WebGPU API**: Modern GPU compute and graphics API (requires Chrome/Edge 113+)
- **JavaScript (ES modules)**: Core visualizer architecture
- **TypeScript**: Physics calculations, Wolfram MCP integration, and scientific UI layer
- **Vite**: Build tool for development and production bundling
- **WGSL**: WebGPU Shading Language for GPU shaders
- **Python 3 + Paramiko**: For SFTP deployment to remote servers
- **GitHub Pages**: For static hosting and CI/CD deployment

## Project Structure

```
/root/power_gen/
├── src/                        # OLD monolithic architecture (still present)
│   ├── main.js                 # SEGVisualizer class (~920 lines)
│   ├── index.html              # Dashboard UI with left/right panels
│   ├── shaders/                # WGSL shaders (imported via ?raw)
│   │   ├── roller.wgsl         # Roller geometry + lighting
│   │   ├── particles.wgsl      # Particle billboard rendering
│   │   ├── compute.wgsl        # GPU compute physics
│   │   ├── flux-lines.wgsl     # Magnetic field line visualization
│   │   ├── magnetic-field.wgsl # Magnetic field calculations
│   │   └── led-solar.wgsl      # LED/Solar specific shaders
│   ├── scientific-ui.js        # Scientific UI components (~1990 lines)
│   ├── scientific-ui.css       # Scientific panel styles
│   ├── scientific-ui/          # Modular UI exports (re-exports from ../scientific-ui.js)
│   ├── styles/                 # Additional styles
│   ├── types.ts                # Core TypeScript type definitions
│   ├── ValidatedConstants.ts   # Physics constants with validation metadata
│   ├── fallback-physics.ts     # Analytical physics formulas with uncertainty
│   ├── mcp-manager.ts          # Wolfram Alpha MCP client
│   ├── integration.ts          # SEGIntegrationManager hub
│   ├── led-solar-integration.ts # LED/Solar/Battery simulation
│   ├── led-solar-constants.ts  # LED/Solar physics constants
│   └── index.ts                # Module exports + initialization helper
│
├── main.js                     # NEW architecture entry point
├── index.html                  # NEW multi-device UI
├── multi-device-visualizer.js  # MultiDeviceVisualizer class (~1000 lines)
├── webgpu-manager.js           # WebGPUManager class (~98 lines)
├── camera-controller.js        # CameraController class (~151 lines)
├── device-instance.js          # DeviceInstance class (~751 lines)
├── device-geometry.js          # DeviceGeometry class (~252 lines)
├── device-pipeline-manager.js  # DevicePipelineManager class (~104 lines)
├── energy-pipe.js              # EnergyPipe class (~21 lines)
├── performance-profiler.js     # PerformanceProfiler class (~400 lines)
├── debug-panel.js              # DebugPanel class (~489 lines)
├── scientific-data.js          # Wolfram-derived constants and formulas (~636 lines)
├── shaders/seg-magnetic.wgsl   # Magnetic field utility functions (reference)
│
├── package.json                # NPM config: vite, typescript
├── vite.config.js              # Vite: root=src, outDir=../dist, HTTPS dev server
├── tsconfig.json               # TypeScript: ES2020, strict, outDir=./dist
├── deploy.py                   # Python SFTP deployment script
├── git.sh                      # Quick git commit/push helper
├── .github/workflows/static.yml # GitHub Actions: deploys repo root to Pages
├── WOLFRAM_DATA_SUMMARY.md     # Scientific data from 4-agent Wolfram swarm
├── claude.md                   # Claude-specific development guide
└── README.md                   # Human-readable project description
```

### Critical Architectural Note: Dual Codebases

The project currently contains **two parallel architectures**:

1. **Old architecture** (`src/main.js`, `src/index.html`): A monolithic `SEGVisualizer` class that handles all WebGPU setup, geometry, pipelines, and rendering in one file. It imports shaders from `src/shaders/*.wgsl?raw`. This was the original implementation.

2. **New architecture** (`main.js`, `index.html`, `multi-device-visualizer.js`, etc.): A modular system using `MultiDeviceVisualizer` which delegates to specialized managers (`WebGPUManager`, `CameraController`, `DeviceInstance`, `DeviceGeometry`, `DevicePipelineManager`, `PerformanceProfiler`, `DebugPanel`). This supports multiple simultaneous devices, energy transfer pipes between them, and an overview camera mode.

**The root `index.html` loads `main.js` and uses the new architecture.** The `src/index.html` is the old dashboard. When making changes, be aware of which architecture you are modifying. Both share the same shader files in `src/shaders/`.

## Key Files Explained

### New Architecture (Root Level)

#### `main.js` (17 lines)
Entry point for the new architecture. Imports all modular managers and initializes `MultiDeviceVisualizer` on window load.

#### `multi-device-visualizer.js` (~1000 lines)
The core of the new architecture. `MultiDeviceVisualizer` class:
- Initializes `WebGPUManager`, `CameraController`, `PerformanceProfiler`, `DebugPanel`
- Manages four device instances (seg, heron, kelvin, solar) via `DeviceInstance`
- Sets up energy pipes connecting devices in a cycle: SEG→Heron→Kelvin→SEG
- Renders a floor grid
- Handles view switching (overview, per-device focus)
- Runs the render loop with FPS counter
- Auto-quality adjustment based on GPU tier and frame rate

#### `webgpu-manager.js` (~98 lines)
`WebGPUManager` class:
- Requests WebGPU adapter with `powerPreference: "high-performance"`
- Requests device with optional `timestamp-query` feature
- Configures canvas context with preferred format and premultiplied alpha
- Creates depth texture (`depth24plus-stencil8`) and global uniform buffer
- Handles resize with device pixel ratio awareness

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
- Supports field line visualization and energy arc visualization for SEG

#### `device-geometry.js` (~252 lines)
`DeviceGeometry` class:
- Generates cylinder geometry for rollers
- Generates sphere geometry for cores
- Creates particle buffers (position + phase seed as vec4f)
- Creates field line particle buffers for SEG
- Creates arc segment buffers for energy arcs
- Initializes SEG-specific geometry (base plate, stator rings, wiring, ring-separator plates, outer coil)

#### `device-pipeline-manager.js` (~104 lines)
`DevicePipelineManager` class:
- Creates roller render pipelines, particle pipelines, core pipelines
- Creates field line pipelines and energy arc pipelines for SEG
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

### Old Architecture (`src/`)

#### `src/main.js` (~920 lines)
The original monolithic `SEGVisualizer` class:
- Initializes WebGPU device and context
- Creates render pipelines for rollers and particles
- Sets up compute pipeline for GPU particle physics
- Handles user interaction (mouse drag, scroll zoom, sliders)
- Runs the render loop with FPS counter
- Integrates TypeScript physics layer via `SEGIntegrationManager`
- Supports four modes: seg, heron, kelvin, solar

#### `src/index.html` (~446 lines)
Original single-page dashboard with:
- Top header bar with status indicator and FPS
- Left sidebar: power controls, drive parameters (speed, magnetic field, load), mode buttons, particle slider
- Center: fullscreen canvas
- Right panel: telemetry (RPM, voltage, current, power, magnetic field, temperature, efficiency, energy)
- Footer: mode and battery status

#### `src/scientific-ui.js` (~1990 lines)
Comprehensive scientific UI components:
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
- **Deploys the entire repository root** (`.`), NOT the `dist/` directory
- No build step in the workflow - files are served as-is
- URL: https://ford442.github.io/seg-webgpu-visualizer/

The workflow uses:
- `actions/checkout@v4`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v3` (path: `.`)
- `actions/deploy-pages@v4`

### SFTP Deployment (Secondary)

Manual deployment to remote server:

```bash
# Ensure dist/ exists first (npm run build creates it)
python deploy.py
```

**Configuration in `deploy.py`**:
- Host: `1ink.us`
- Port: `22`
- User: `ford442`
- Remote path: `test.1ink.us/powergen`
- Local source: `dist/` directory
- **Password is hardcoded in plaintext on line 45**

## Code Organization

### Main Classes (New Architecture)

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

1. **`roller.wgsl`** (~330 lines): Vertex + fragment shader for device geometry
   - Transforms cylinders/spheres for all four modes
   - Instance-index conventions: 0-65 rollers, 66 core, 67 coil, 68-71 plates, 100-101 Kelvin rings, 200+ solar disc
   - Mode-specific materials: SEG metallic with green underglow, Heron steel/water, Kelvin copper with electrostatic shimmer, Solar LED warm glow + battery indicator
   - Fresnel and specular lighting

2. **`particles.wgsl`** (~85 lines): Billboards particles as quads
   - Camera-facing orientation
   - Circular alpha blending

3. **`compute.wgsl`** (~133 lines): GPU compute physics
   - Workgroup size: 64
   - `posSEG()`: Spiral inward from outer ring, 3 full turns per cycle
   - `posHeron()`: Rising jet → falling arc → draining tube
   - `posKelvin()`: Falling droplets with wobble + spark discharge
   - `posSolar()`: Photons in straight lines from LEDs to solar panel

4. **`flux-lines.wgsl`** (~487 lines): Magnetic field line visualization for SEG

5. **`magnetic-field.wgsl`** (~459 lines): Magnetic field calculation utilities

6. **`led-solar.wgsl`** (~1544 lines): LED/Solar specific shaders

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

- Particle count per device: 1,000 to 20,000 (new architecture) or 1,000 to 50,000 (old)
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
- **`deploy.py` contains hardcoded password in plaintext** (line 45)
- No input sanitization (not applicable for this static visualization)

### WebGPU Security
- WebGPU requires secure context (HTTPS or localhost)
- GPU memory access is sandboxed by browser
- No sensitive data processed in the application

### Recommendations
- Move deployment credentials to environment variables
- Use SSH keys instead of password authentication
- Add `.env` to `.gitignore` if implementing credential files

## Future Extension Points

The codebase is designed for extension:
- `mode` system in shaders allows adding new physics simulations
- `DeviceInstance` pattern makes adding new device types straightforward
- `EnergyPipe` can connect any two devices
- WGSL utility functions in `src/shaders/` can be integrated into main pipelines
- Scientific UI gauges are modular and can be added/removed
- `PerformanceProfiler` auto-quality system adapts to new rendering loads

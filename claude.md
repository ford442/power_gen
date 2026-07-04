# Claude Development Guide for SEG WebGPU Visualizer

## Project Overview
This project is a real-time WebGPU simulation of the Searl Effect Generator (SEG) with extensible architecture for future additions like Heron's Fountain and Kelvin's Thunderstorm.

**Live Demo:** https://ford442.github.io/power_gen/

## Key Features
- Multi-device layout: SEG, Heron, Kelvin, Solar, Peltier, MHD (6 `DeviceInstance`s)
- 36 instanced SEG rollers (3 rings) + 10,000–50,000 GPU particles per device
- Interactive orbital camera (drag to rotate, scroll to zoom)
- **WebGL2 fallback renderer** for debugging, CI, and agent visual testing

## Browser Requirements
- **WebGPU (default):** Chrome/Edge 113+, HTTPS or localhost
- **WebGL2 fallback:** any browser with WebGL2 — use `?renderer=webgl2`

## Dual Renderer Architecture

| Path | Entry | Backend |
|------|-------|---------|
| Primary | `main.js` → `MultiDeviceVisualizer` | WebGPU via `webgpu-manager.js` |
| Fallback | `main.js` → `WebGL2MultiDeviceVisualizer` | WebGL2 via `src/renderers/webgl2/` |

**Selection:** URL `?renderer=webgl2|webgpu`, `localStorage seg-renderer`, or `window.DEBUG_RENDERER`. Hot-switch: `setRenderer('webgl2')`.

### WebGL2-first development workflow

1. Prototype geometry/materials/particles in WebGL2 (`src/renderers/webgl2/shaders.js` GLSL).
2. Keep simulation in `src/renderers/shared/` — `particle-physics.js` mirrors `compute.wgsl`; `device-physics.js` mirrors `stepPhysics()`.
3. Port visuals to WebGPU only after WebGL2 looks correct — translate GLSL → WGSL in `multi-device-shaders.js`.

### WebGPU → WebGL2 mapping

| WebGPU | WebGL2 |
|--------|--------|
| `compute.wgsl` dispatch | `stepParticles()` CPU loop |
| Storage buffer instances | `drawElementsInstanced` + attrib divisor |
| Bind groups @group(0) | `uniform mat4 u_viewProj` + UBOs |
| `WebGPUManager.init()` | `WebGL2Context.init()` |

Agent hooks: `window.currentRenderer`, `canvas.dataset.renderer`, `window.captureCanvasFrame()`, `window.getRendererInfo()`.

## Project Structure
```
power_gen/
├── README.md
├── claude.md
├── src/
│   ├── main.js                    # Bootstrap: renderer selection + WASM
│   ├── multi-device-visualizer.js # Primary WebGPU orchestrator
│   ├── webgpu-manager.js
│   ├── renderers/
│   │   ├── renderer-selector.js
│   │   ├── shared/                # CPU physics + geometry (both backends)
│   │   └── webgl2/                # GLSL shaders + WebGL2 visualizer
│   └── shaders/*.wgsl
└── dist/
```

## Local Development

### Prerequisites
- Node.js 16+ with npm
- WebGPU capable browser (Chrome/Edge 113+)

### Setup and Running
```bash
# Install dependencies
npm install

# Development server (with hot reload)
npm run dev
```
Then navigate to `https://localhost:5173` in your browser.

The dev server provides:
- Hot module reloading for fast iteration
- HTTPS by default (required for WebGPU)
- Automatic WGSL shader reloading

## Key Files and Their Purposes

### src/main.js
The core application logic containing:
- SEGVisualizer class managing WebGPU state
- Geometry generation (cylinder rollers)
- Pipeline setup and rendering loop
- Camera controls and interaction handling
- Particle system initialization and updates
- Imports shaders from src/shaders/ with `?raw` directive

### src/shaders/roller.wgsl
Vertex and fragment shaders for:
- Rendering 12 magnetic roller geometries
- Computing roller position and rotation in toroidal formation
- Mode-specific visual effects (SEG, Heron's Fountain, Kelvin's Thunderstorm)
- Fresnel and specular lighting calculations

### src/shaders/particles.wgsl
Vertex and fragment shaders for:
- Rendering 10k-50k particles as billboards
- Camera-facing orientation
- Mode-dependent particle animations

### src/shaders/compute.wgsl
GPU compute shader implementing **stateful kinematic integration** (semi-implicit
Euler). Each particle is a persistent 32-byte record (position, phase seed, velocity,
aux scalar) advanced each frame by real forces, then recycled at a mode-specific spawn:
- SEG: tangential Lorentz drive toward ω·R with radial/vertical confinement to the rings
- Heron's Fountain: gravity + aerodynamic drag; spawn velocity = Bernoulli/Swamee–Jain exit speed
- Kelvin's Thunderstorm: gravity − Stokes drag + Coulomb qE; charge (`aux`) set at pinch-off
- Solar/LED: ballistic photons; Snell + Fresnel decide specular reflection vs absorption

Global per-device state (roller ω, reservoir head, bucket voltage, battery) is integrated
on the CPU in `main.js` (`stepPhysics`) and passed to the shaders via the shared uniform
buffer. `src/shaders/lightning.wgsl` renders the Kelvin discharge bolt.

### src/index.html
HTML template containing:
- Canvas element for WebGPU rendering
- Control UI (buttons, sliders)
- CSS styling
- Script entry point: `<script type="module" src="main.js"></script>`

### vite.config.js
Vite configuration that:
- Sets `src/` as root directory
- Outputs built files to `dist/`
- Configures HTTPS for local dev server
- Handles WGSL shader imports with `?raw`

## Building for Production

```bash
# Build optimized output to dist/
npm run build

# Preview production build locally
npm run preview
```

Vite will:
- Bundle and minify JavaScript
- Inline shader code from `?raw` imports
- Generate optimized assets
- Output to `dist/` directory

## Deployment

### GitHub Pages (Automatic)
```bash
git push origin main
```
- Triggered by `.github/workflows/static.yml`
- Builds and deploys to: https://ford442.github.io/power_gen/

### Manual SFTP Deployment to 1ink.us
```bash
npm run deploy
```
Alternatively:
```bash
npm run build && python deploy.py
```
- Builds the project first
- Uploads `dist/` directory to `1ink.us` server via SFTP
- Server: `1ink.us:22`
- Remote path: `test.1ink.us/powergen`
- Username: `ford442`
- Note: Update credentials in deploy.py (preferably use environment variables)

## Development Workflow

1. Create feature branch from main
2. Run `npm install` to ensure dependencies
3. Start dev server with `npm run dev`
4. Make changes to src/ files (hot reload enabled)
5. Test all visualization modes and interactions
6. Commit with clear messages
7. Push to branch
8. Create pull request for review
9. Main branch: GitHub Actions auto-deploys to GitHub Pages
10. For 1ink.us: Run `npm run deploy` manually

## Git Branches
- `main` - Production-ready code, auto-deploys to GitHub Pages
- `claude/create-claude-md-*` - Claude Code development branches
- Use descriptive branch names for features/fixes

## Architecture Notes

### Build System (Vite)
- **Module-based**: Each component (shaders, main logic) is a module
- **WGSL Shader Loading**: Shaders imported as raw text with `?raw` directive
  ```javascript
  import shaderCode from './shaders/roller.wgsl?raw';
  ```
- **Production Optimization**: Minification, tree-shaking, asset bundling
- **Dev Experience**: Hot Module Replacement (HMR) for fast iteration

### WebGPU Pipeline
The simulation uses:
1. **Compute Pass**: Updates particle positions each frame
   - Dispatches 64-workgroup compute shader
   - Handles mode-specific physics
2. **Render Pass**: Renders scene in two stages
   - First: Render roller geometries (12 instanced cylinders)
   - Second: Render particles as billboards (triangle-strip quads)

### Particle System
- Configurable count: 1k-50k particles
- Storage buffer (32 bytes/particle: position, phase, velocity, aux) shared between the
  compute and vertex stages; state persists across frames
- Stateful per-particle integration on the GPU; small per-device ODEs (ω, head, voltage,
  battery) integrated on the CPU and fed in via uniforms
- Switching mode re-seeds the particle buffer (`onModeChange`) since velocity/aux differ

### Camera System
- Orbital controls: mouse drag to rotate, scroll to zoom
- Stored in `this.camera` object
- Perspective matrix computed each frame
- Smooth interpolation of rotations

## Common Tasks

### Adding a New Visualization Mode
1. **Update src/shaders/compute.wgsl** - Add new mode physics
2. **Update src/shaders/roller.wgsl** - Add fragment shader color/effect logic
3. **Update src/main.js** - Add mode to modeMap in updateUniforms()
4. **Update src/index.html** - Add button for new mode
5. Test with `npm run dev`
6. Rebuild with `npm run build` before deployment

### Modifying Particle System
```javascript
// In src/main.js, line 54:
this.particleCount = 10000;  // Change this value
```
- Range: 1,000 to 50,000
- Higher counts reduce frame rate on low-end GPUs
- Test performance with `npm run preview`

### Updating Shader Code
1. Edit files in `src/shaders/*.wgsl`
2. Dev server hot-reloads automatically (if running `npm run dev`)
3. Or refresh browser to reload
4. Check browser console (F12) for shader compilation errors

### Adding Dependencies
```bash
npm install <package-name>
```
- Update package.json automatically
- Vite handles bundling

## Troubleshooting

### Development Server Issues
```bash
# "npm: command not found"
# Install Node.js from https://nodejs.org/

# Port 5173 already in use
# Kill the process or specify a different port:
npx vite --port 5174

# SSL certificate errors
# Vite auto-generates self-signed certs; trust browser certificate
```

### WebGPU Not Available
- Ensure Chrome/Edge 113+ or Firefox Nightly with WebGPU enabled
- Check `chrome://gpu` to verify WebGPU support
- Use HTTPS or localhost (not http://)
- Disable browser extensions that might block WebGPU

### Build Failures
```bash
# Clear build cache and reinstall
rm -rf node_modules dist
npm install
npm run build

# Check for TypeScript/syntax errors in console
# Vite provides detailed error messages
```

### Shader Compilation Errors
- Check browser console (F12) for error messages
- Common issues:
  - Mismatched binding groups in compute vs render pipelines
  - Incorrect struct member alignment
  - Wrong entry point names (must match `@compute`, `@vertex`, `@fragment` functions)

### Performance Issues
- Reduce particle count via UI slider or `main.js` initialization
- Disable browser extensions
- Check GPU memory usage in browser DevTools
- Use `npm run preview` to test production performance

### Deployment Failures
```bash
# GitHub Pages: Check workflow status at:
# https://github.com/ford442/power_gen/actions

# 1ink.us SFTP: Verify credentials and paths
# Deploy interactively for debugging:
npm run build
python deploy.py --verbose  # (if supported)

# Check dist/ directory was created:
ls dist/
```

## Future Enhancements
- Heron's Fountain simulation
- Kelvin's Thunderstorm simulation
- Performance optimizations
- Mobile WebGPU support
- Advanced camera controls

## Contact & Resources
- Repository: https://github.com/ford442/power_gen
- Live Demo: https://ford442.github.io/power_gen/

# SEG WebGPU Visualizer - Agent Guide

## Project Overview

This is a **SEG (Searl Effect Generator) WebGPU Visualizer** - a real-time 3D simulation that runs in the browser using the WebGPU API. It visualizes three different physics phenomena:

1. **Searl Effect Generator (SEG)**: 12 magnetic rollers arranged in a toroidal formation with spiral energy flux patterns
2. **Heron's Fountain**: Fluid dynamics simulation with siphon-driven water jets
3. **Kelvin's Thunderstorm**: Electrostatic induction simulation with falling charged droplets

**Live Demo**: https://ford442.github.io/seg-webgpu-visualizer/

## Technology Stack

- **WebGPU API**: Modern GPU compute and graphics API (requires Chrome/Edge 113+)
- **Vanilla JavaScript**: No frameworks or build tools
- **WGSL**: WebGPU Shading Language for GPU shaders
- **Python 3 + Paramiko**: For SFTP deployment to remote servers
- **GitHub Pages**: For static hosting and CI/CD deployment

## Project Structure

```
/workspaces/power_gen/
├── index.html              # Main HTML entry point with embedded CSS
├── main.js                 # Core application logic (SEGVisualizer class)
├── shaders/
│   └── seg-magnetic.wgsl   # WGSL utility functions for magnetic field calculations
├── deploy.py               # Python SFTP deployment script
├── git.sh                  # Quick git commit/push helper script
├── .github/
│   └── workflows/
│       └── static.yml      # GitHub Actions workflow for Pages deployment
└── README.md               # Human-readable project documentation
```

### Key Files Explained

#### `main.js`
The core of the application. Contains the `SEGVisualizer` class which:
- Initializes WebGPU device and context
- Creates render pipelines for rollers and particles
- Sets up compute pipeline for GPU particle physics
- Handles user interaction (mouse drag, scroll zoom, sliders)
- Runs the render loop with FPS counter

Shaders are embedded as strings in this file (not loaded from external files).

#### `index.html`
Single-page HTML with embedded CSS. Contains:
- UI controls panel with mode buttons
- Sliders for rotation speed (0-5x) and particle count (1,000-50,000)
- Fullscreen canvas for WebGPU rendering
- Stats display (FPS and current mode)

#### `shaders/seg-magnetic.wgsl`
Utility functions for magnetic field calculations. **Note**: These functions are defined here for reference but are NOT currently used by `main.js` (which has inline shaders).

#### `deploy.py`
SFTP deployment script to upload files to `test.1ink.us/powergen`. 
**⚠️ Security Warning**: Contains hardcoded credentials (password in plaintext).

## Build and Development

### No Build Process Required

This is a static website with no build step. Files are served directly as-is.

### Local Development

```bash
# Requires HTTPS for WebGPU to work
npx serve . --ssl
```

Or use any static server with HTTPS support.

### Browser Requirements

- Chrome 113+ or Edge 113+
- WebGPU must be enabled (enabled by default in these versions)
- Requires HTTPS or localhost context

## Code Organization

### Main Classes

```javascript
class SEGVisualizer {
  // WebGPU device and context
  device, context
  
  // Pipelines
  renderPipeline      // For 3D roller geometry
  particlePipeline    // For particle rendering
  computePipeline     // For GPU particle physics
  
  // Buffers
  uniformBuffer       // Camera matrices, time, mode settings
  vertexBuffer        // Cylinder geometry for rollers
  indexBuffer         // Cylinder indices
  particleBuffer      // Particle positions (vertex + storage usage)
  depthTexture        // Depth buffer
  
  // State
  mode                // 'seg' | 'heron' | 'kelvin'
  particleCount       // 1000 - 50000
  time                // Accumulated simulation time
  camera              // { distance, rotation, height }
}
```

### Shader Architecture

Shaders are written in WGSL and embedded as JavaScript strings in `main.js`:

1. **Vertex Shader** (`vertexCode`): Transforms cylinder geometry for 12 rollers with rotation animation
2. **Fragment Shader** (`fragmentCode`): Applies different visual styles based on mode
3. **Particle Vertex Shader** (`particleVertCode`): Billboards particles as quads
4. **Particle Fragment Shader** (`particleFragCode`): Circular particle alpha blending
5. **Compute Shader** (`computeCode`): Updates particle positions on GPU based on physics mode

### Mode System

Three simulation modes identified by numeric constants:
- `0.0` = SEG: Spiral converging energy flux
- `1.0` = Heron's Fountain: Rising/falling fluid particles
- `2.0` = Kelvin's Thunderstorm: Electrostatic falling droplets

## Deployment

### GitHub Pages (Primary)

Automatic deployment on push to `main` branch via `.github/workflows/static.yml`:
- Deploys entire repository root to GitHub Pages
- No build step - files served as-is
- URL: https://ford442.github.io/seg-webgpu-visualizer/

### SFTP Deployment (Secondary)

Manual deployment to remote server using Python script:

```bash
# First ensure 'dist' directory exists with files
python deploy.py
```

**Configuration in `deploy.py`**:
- Host: `1ink.us`
- User: `ford442`
- Remote path: `test.1ink.us/powergen`
- Local source: `dist/` directory

## Code Style Guidelines

### JavaScript Style
- ES6+ class-based architecture
- Async/await for WebGPU initialization
- Single-letter variable names common in math-heavy sections
- Minimal comments - code is self-documenting
- Inline shader strings use template literals

### WGSL Shader Style
- Type annotations explicit (`vec3f`, `mat4x4f`, `f32`)
- Binding and group attributes for resources: `@binding(0) @group(0)`
- Entry points marked with `@vertex`, `@fragment`, `@compute`
- Workgroup size 64 for compute shaders

## Testing

No automated test suite exists. Testing is manual:

1. Open `index.html` in Chrome/Edge 113+
2. Verify WebGPU initializes without error
3. Test all three mode buttons
4. Adjust sliders for speed and particle count
5. Verify mouse interaction (drag to rotate, scroll to zoom)
6. Check FPS stays reasonable (target 60 FPS)

## Security Considerations

### Current Issues
- **`deploy.py` contains hardcoded password** in plaintext (line 45)
- No input sanitization (not applicable for this static visualization)

### WebGPU Security
- WebGPU requires secure context (HTTPS or localhost)
- GPU memory access is sandboxed by browser
- No sensitive data processed in the application

### Recommendations
- Move deployment credentials to environment variables
- Use SSH keys instead of password authentication
- Add `.env` to `.gitignore` if implementing credential files

## Performance Notes

- Particle count adjustable: 1,000 to 50,000
- Workgroup size: 64 threads per compute dispatch
- Double-buffered rendering with depth testing
- Instanced rendering for 12 rollers (single draw call)
- FPS counter updates every ~500ms

## Future Extension Points

The codebase is designed for extension:
- `mode` system allows adding new physics simulations
- WGSL utility functions in `shaders/` can be integrated
- Three-ringed SEG configuration mentioned as future upgrade
- Additional visualization modes can be added to modeMap and shaders

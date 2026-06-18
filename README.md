# SEG WebGPU Visualizer

Real-time WebGPU simulation of the Searl Effect Generator (SEG) with extensible architecture for Heron's Fountain and Kelvin's Thunderstorm.

**Live Demo:** https://ford442.github.io/seg-webgpu-visualizer/

## Features
- Three concentric rings of instanced magnetic rollers in toroidal formation
- 10,000-50,000 GPU particles driven by **stateful kinematic integration** (persistent
  per-particle position + velocity in a storage buffer, advanced each frame by real forces)
- Four physically-modelled modes:
  - **SEG** — roller spin-up from moment of inertia, Lorentz drive torque and Lenz
    eddy-current braking to a self-regulating terminal velocity (with coronal glow)
  - **Heron's Fountain** — Bernoulli exit velocity with Swamee–Jain pipe friction and
    depleting head pressure; droplets bunch realistically at the apex
  - **Kelvin's Thunderstorm** — charged droplets under gravity + Stokes drag + Coulomb
    repulsion, capacitive voltage runaway, electrostatic levitation, and a fractal
    (midpoint-displacement) discharge at dielectric breakdown
  - **LEDs + Solar** — photons reflected/absorbed by Snell + Fresnel optics on silicon
- Interactive orbital camera (drag to rotate, scroll to zoom)

## Future Plans
- Add Quanta Magnetics devices to the visualization suite

## Browser Support
- **WebGPU (default):** Chrome/Edge 113+ with WebGPU enabled. Requires HTTPS or localhost.
- **WebGL2 fallback:** Any browser with WebGL2 — for debugging, CI, and agent-driven visual testing when WebGPU is unavailable or hard to automate.

## WebGL2 Fallback Renderer

A toggleable WebGL2 path renders the same multi-device scene (SEG rollers, particles, sky/grid) using shared simulation state. Use it for Playwright screenshots, geometry/material iteration, and porting features to WebGPU.

### Enable WebGL2 mode

| Method | Example |
|--------|---------|
| URL parameter | `?renderer=webgl2` |
| Browser console | `setRenderer('webgl2')` then reload |
| localStorage | `localStorage.setItem('seg-renderer', 'webgl2')` |
| Global (dev) | `window.DEBUG_RENDERER = 'webgl2'` before load |

Switch back: `?renderer=webgpu` or `setRenderer('webgpu')`.

### Debug keys (WebGL2 only)

| Key | Action |
|-----|--------|
| `W` | Wireframe overlay |
| `P` | Cycle particle debug (glow → ID/phase → velocity heat) |
| `N` | Normal debug coloring |
| `Space` | Pause / resume simulation |
| `.` | Single simulation step |
| `[` / `]` | Slow-motion factor |

### Agent / CI hooks

```js
window.currentRenderer          // 'webgpu' | 'webgl2'
document.querySelector('#gpuCanvas').dataset.renderer
window.captureCanvasFrame()     // { width, height, pixels } — WebGL2
window.getRendererInfo()        // fps, particle count, debug state
```

## Local Development
```bash
npm install
npm run dev
# WebGL2: http://localhost:5173/?renderer=webgl2
# WebGPU: http://localhost:5173/
```
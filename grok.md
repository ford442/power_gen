# grok.md — Grok AI Assistant Guide for power_gen

> Read this first.

## Project Overview
**power_gen** is a visualization tool for the SEG magnetic generator and other alternative energy devices.

- **Purpose**: Educational and exploratory visualization of energy generation concepts.
- **Focus**: Making complex physics or engineering ideas visually understandable and engaging.

## Technology Stack
- JavaScript (Vite)
- **WebGPU** — primary renderer (`MultiDeviceVisualizer`)
- **WebGL2** — debug/CI fallback (`src/renderers/webgl2/`)

## C++ WASM Physics Path
A high-precision C++ (Emscripten) physics path runs alongside the JS/WebGPU implementation:
- Enable with `?wasmPhysics=1` or the debug panel toggle (persisted via localStorage).
- Recommended consumer: `src/wasm/seg-physics-bridge.js` (also `src/wasm/sim.ts`).
- Focus: SEG-mode rollers with RK4 integration (exact dipole B-field calcs).
- Non-SEG modes (Heron, Kelvin) are stubs. Particle buffer export and per-ring torques are supported for sync/export scenarios.

## WebGL2-First Workflow (Recommended for Graphics Work)

When iterating on geometry, materials, or particles:

1. **Start in WebGL2 mode** — `?renderer=webgl2` or `setRenderer('webgl2')`. GLSL is easier to debug than WGSL; Playwright can capture pixels via `window.captureCanvasFrame()`.
2. **Share state** — particle arrays, roller positions, and physics constants come from `src/renderers/shared/` and `ValidatedConstants.ts`. Do not duplicate simulation logic.
3. **Port to WebGPU** — once visuals look right in WebGL2, translate GLSL → WGSL in `multi-device-shaders.js` or `src/shaders/*.wgsl`. Map instancing: GL `drawElementsInstanced` ↔ WebGPU `drawIndexed` with storage-buffer instances.

### WebGPU ↔ WebGL2 mapping
| WebGPU | WebGL2 fallback |
|--------|-----------------|
| Compute shader (`compute.wgsl`) | `shared/particle-physics.js` (CPU) |
| Storage buffers | `Float32Array` + `bufferSubData` |
| Bind groups | Uniform blocks + attrib divisors |
| `firstInstance` offsets | Per-draw instance ranges |

## Grok Guidelines
- **Clarity & Education**: The main goal is to help people understand how these devices work through visuals.
- **Visual Appeal**: Even technical visualizations benefit from clean, attractive design.
- **Interactivity**: Sliders, toggles, or real-time parameter changes make it much more powerful.
- **Accuracy**: Keep the physics/engineering representation reasonably accurate while still being visually compelling.

## Common Tasks
- Improve visualization quality and animations
- Add more devices or variations
- Enhance interactivity and controls
- Add explanatory overlays or tooltips
- Optimize performance

A great way to communicate technical ideas. Let’s make the concepts come alive. ⚡
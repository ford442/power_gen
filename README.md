# SEG WebGPU Visualizer

Real-time WebGPU simulation of the Searl Effect Generator (SEG) with extensible architecture for Heron's Fountain and Kelvin's Thunderstorm.

**Live Demo:** https://ford442.github.io/seg-webgpu-visualizer/

## Features
- 12 instanced magnetic rollers in toroidal formation (ready to upgrade to three ringed SEG or other configuration)
- 10,000-50,000 GPU compute shader particles
- Interactive orbital camera (drag to rotate, scroll to zoom)
- Three visualization modes: SEG, Heron's Fountain, Kelvin's Thunderstorm

## Future Plans
- Add Quanta Magnetics devices to the visualization suite

## Browser Support
Chrome/Edge 113+ with WebGPU enabled. Requires HTTPS or localhost.

## Local Development
```bash
npx serve . --ssl
```
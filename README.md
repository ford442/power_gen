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
Chrome/Edge 113+ with WebGPU enabled. Requires HTTPS or localhost.

## Local Development
```bash
npx serve . --ssl
```
# cpp/ – SEG Simulation Core (C++ → WebAssembly)

This directory contains a C++17 simulation core that compiles to WebAssembly
(WASM) using Emscripten. It provides high-performance, high-precision CPU-side
physics that complements the WebGPU compute shaders:

| Feature | GPU (compute.wgsl) | WASM (sim_core.cpp) |
|---|---|---|
| Particle system | ✅ 10–50k real-time | ✅ CPU-side replay |
| SEG roller dynamics | Semi-implicit Euler | **RK4 integrator** |
| Magnetic field | Approximated | Exact dipole formula |
| Double-precision | ❌ f32 only | ✅ f64 possible |
| Off-screen/export | ❌ | ✅ |

## Quick Start

### Prerequisites

Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html):

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install 3.1.61
./emsdk activate 3.1.61
source ./emsdk_env.sh
```

### Build WASM

```bash
# from repository root — portable wrapper (PATH or EMSDK)
npm run wasm:build

# or with explicit SDK root
export EMSDK=/path/to/emsdk
npm run wasm:build

# or directly once emcc is on PATH
cd cpp && make wasm
```

`scripts/build-wasm.sh` resolves Emscripten in order: `emcc` on PATH →
`$EMSDK/emsdk_env.sh` → `$HOME/emsdk/emsdk_env.sh`.

Output: `src/public/wasm/sim_core.js` + `src/public/wasm/sim_core.wasm`

**Site deploy does not require Emscripten** — use `npm run build:site` and the
committed prebuilt WASM. Full `npm run build` rebuilds WASM first.

### Native smoke-test (no Emscripten needed)

```bash
npm run wasm:native
# or
cd cpp && make native
```

Native smoke exercises **SEG**, **Heron**, **Kelvin**, **Solar**, **Peltier**, and
**MHD** plant modes plus zero-copy buffer packing
(`getRollerStateFloatCount == 66*4`). Single-mode smoke runs:

```bash
./build/sim_core_test --mode peltier   # thermoelectric stack smoke
./build/sim_core_test --mode mhd      # Hartmann channel smoke
```

Plant modes (SimMode enum): `0=SEG` RK4 rollers, `1=Heron` Bernoulli /
Swamee–Jain, `2=Kelvin` capacitive + spark, `3=Solar` battery SOC,
`4=Peltier` simplified 1D Seebeck/Peltier two-node stack (Thomson neglected),
`5=MHD` Hartmann-style channel flow with Lorentz braking and induced load
voltage.

### Zero-copy particle / roller buffers

After `sim.step` / `packRollerState`:

```js
import { segWasm } from './wasm/seg-physics-bridge.js';
await segWasm.init();
// HEAPF32 view (invalidated if WASM heap grows — re-fetch each frame)
const particles = segWasm.getParticleFloatView(); // Float32Array, 8 floats/particle
const rollers   = segWasm.getRollerStateFloatView(); // [angle, omega, radius, height] × N
// Live metric used by MultiDevice when ?wasmPhysics=1:
console.log('mean |ω|', segWasm.lastRollerMeanOmega);
```

Enable live WASM plant: `?wasmPhysics=1` or debug panel toggle (persists to localStorage).
### Debug WASM build

```bash
npm run wasm:build-debug
# → src/public/wasm/sim_core_dbg.js (with DWARF debug info)
```
## File Structure

```
cpp/
  src/
    sim_core.h       ← Vec3, SimParticle, SEGRollerState, function declarations
    sim_core.cpp     ← full implementation + Embind bindings
  CMakeLists.txt     ← CMake / Emscripten build
  Makefile           ← simple make wasm / native targets
  build/             ← native test binaries (gitignored)
```

## JavaScript / TypeScript API

Once built, the module is loaded asynchronously with graceful fallback:

```typescript
import { SEGSim } from './wasm/sim';

const sim = await SEGSim.create();   // returns no-op stub if WASM unavailable
if (sim.wasmAvailable) {
  const state = sim.step(1/60, 0.01);
  console.log(state.rpm);            // RK4-integrated RPM
  sim.dispose();
}
```

Low-level access via the raw Emscripten module:

```typescript
import { loadSimCore } from './wasm/index';

const mod = await loadSimCore();
if (mod) {
  const B = mod.axialBField(0, 0.05, 0.025, 1.48);
  console.log('Axial B-field:', B, 'T');

  const sim = new mod.SEGSimulator();
  for (let i = 0; i < 600; i++) sim.step(1/60, 0.1);
  console.log('RPM after 10s:', sim.getRPM());
  sim.delete();
}
```

## CI

The GitHub Actions workflow `.github/workflows/build-wasm.yml` builds the WASM
automatically on every push that touches `cpp/` or `src/wasm/`, and commits the
artefacts back to `src/public/wasm/` on the `main` branch so GitHub Pages can
serve them without a separate npm build step.

## Next Steps / Roadmap

Recent non-breaking expansions (SEGSimulator API and all prior bindings preserved):

- **Particle buffer export**: `getParticles(maxCount?)` returns a JS array of
  `SimParticle` objects (full or prefix). Complements the existing single
  `getParticle(i)`. JavaScript side (via `seg-physics-bridge.js` and `sim.ts`)
  can now pull the high-precision CPU particle state for seeding or diffing
  against the WebGPU side.
- **Multi-mode plants**: `setMode(0..5)` / `getMode()`. 0 = SEG (full RK4
  roller path), 1 = Heron (Bernoulli / Swamee–Jain), 2 = Kelvin (capacitive +
  spark), 3 = Solar (battery SOC), 4 = Peltier (two-node Seebeck stack),
  5 = MHD (Hartmann channel). Every mode has real dynamics, mode-aware
  particle seeding/stepping, and dedicated telemetry getters.
- **Per-ring load torque**: `setRingLoadTorque(ring, t)`, `setRingLoadTorques(t0, t1, t2)`,
  and `stepWithPerRingTorques(dt)`. The original `step(dt, loadTorque)` continues
  to broadcast its value to all rings (identical prior behaviour).

Thin JS wrappers live in `src/wasm/seg-physics-bridge.js` and `src/wasm/sim.ts`
so the debug panel and future consumers can call the new functionality directly.

Since implemented: real dynamics for all six modes (Heron, Kelvin, Solar,
Peltier, MHD alongside SEG), zero-copy particle + roller buffers, and
mode-aware particle seeding / stepping.

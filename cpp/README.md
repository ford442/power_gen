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
# from repository root
npm run wasm:build
# or directly
cd cpp && make wasm
```

Output: `src/public/wasm/sim_core.js` + `src/public/wasm/sim_core.wasm`

### Native smoke-test (no Emscripten needed)

```bash
cd cpp && make native
# or manually:
g++ -std=c++17 -O2 -DSIM_CORE_STANDALONE -I src src/sim_core.cpp -o build/sim_core_test
./build/sim_core_test
```

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

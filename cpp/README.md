# cpp/ – SEG Simulation Core (C++ → WebAssembly)

This directory contains a C++17 simulation core that compiles to WebAssembly
(WASM) using Emscripten. It provides high-performance, high-precision CPU-side
physics that complements the WebGPU compute shaders:

| Feature | GPU (compute.wgsl) | WASM (`cpp/src/sim_core_*.cpp` + `plant/`) |
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

Native smoke exercises **SEG**, **Heron**, **Kelvin**, **Solar**, **Peltier**,
**MHD**, **Maglev**, **Homopolar**, **Transformer**, **Van de Graaff**,
**Hall-Effect Bench**, and **Lorentz Rail Sled** plant modes plus zero-copy
buffer packing
(`getRollerStateFloatCount == 66*4`). Single-mode smoke runs:

```bash
./build/sim_core_test --mode peltier   # thermoelectric stack smoke
./build/sim_core_test --mode mhd       # Hartmann channel smoke
./build/sim_core_test --mode maglev    # Quanta gap ODE smoke
./build/sim_core_test --mode homopolar # Faraday disc L–R smoke
./build/sim_core_test --mode transformer # coupled-inductor L–M smoke
./build/sim_core_test --mode vdg         # belt-charge/leakage/spark-gap ODE smoke
./build/sim_core_test --mode hall        # I·B → Hall-voltage smoke
./build/sim_core_test --mode lorentz-sled # rail-motor R–L + back-EMF + friction smoke
./build/sim_core_test --mode chores      # gpu-chores reduce/map goldens
./build/sim_core_test --mode catalog     # print id → wasmMode; fail on holes/dupes
./build/sim_core_test --mode bench       # print bench_seg_steps_per_sec / bench_particle_steps_per_sec
```

Plant modes (SimMode enum): `0=SEG` RK4 rollers, `1=Heron` Bernoulli /
Swamee–Jain, `2=Kelvin` capacitive + spark, `3=Solar` battery SOC,
`4=Peltier` simplified 1D Seebeck/Peltier two-node stack (Thomson neglected),
`5=MHD` Hartmann-style channel flow with Lorentz braking and induced load
voltage, `6=Maglev` spring–damper gap ODE (mirrors Quanta JS),
`7=Homopolar` Faraday disc L–R + back-EMF (mirrors Quanta JS),
`8=Transformer` coupled-inductor ODE (JS phasor is the no-WASM fallback),
`9=VDG` Van de Graaff belt-charge/leakage/spark-gap ODE (mirrors Quanta JS),
`10=Hall` algebraic I·B → Hall-voltage model (mirrors Quanta JS),
`11=LorentzSled` rail-motor R–L drive loop + back-EMF + `F = I ℓ × B` on a
sliding armature against friction (mirrors Quanta JS) — an educational
Lorentz-force bench, not a railgun design tool.
Free helper `estimateHalbachFieldT(gap, Br)` mirrors the JS Halbach gap estimate
for offline field sampling (halbach-viz remains CPU-JS for field lines; Pulse
Coil also stays CPU-JS — neither has a `wasmMode`).

### Compilation database (clangd)

CI smoke stays `make native` / `npm run wasm:native`. For per-TU include
paths (`-DSIM_CORE_STANDALONE`, `-I src`) so clangd can jump from
`plant/vdg_plant.cpp` into `VdgState` / `SEGSimulator`:

```bash
# from repository root
cmake -S cpp -B cpp/build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
ln -sfn cpp/build/compile_commands.json compile_commands.json

# or from cpp/
make compile-db
```

`cpp/build/` (except `cpp/build/README.md`) and the repo-root
`compile_commands.json` symlink are gitignored. `.clangd` sets
`CompilationDatabase: cpp/build`. Do not commit the JSON.

### Zero-copy particle / roller buffers

After `sim.step` / `packRollerState`:

```js
import { segWasm } from './wasm/seg-physics-bridge';
await segWasm.init();
// HEAPF32 view (invalidated if WASM heap grows — re-fetch each frame)
const particles = segWasm.getParticleFloatView(); // Float32Array, 8 floats/particle
const rollers   = segWasm.getRollerStateFloatView(); // [angle, omega, radius, height] × N
// Live metric used by MultiDevice when ?wasmPhysics=1:
console.log('mean |ω|', segWasm.lastRollerMeanOmega);
```

Enable live WASM plant: `?wasmPhysics=1` or debug panel toggle (persists to localStorage).

### WASM ABI / zero-copy contract

**Single source of Emscripten flags:** `cpp/emscripten.flags` (consumed by `Makefile` and
`CMakeLists.txt`). Do not duplicate `-s EXPORT_*` / memory settings in one build path only.
`CMakeLists.txt` applies every line to both the per-file compile step and the final link
step (the Makefile's single `em++ … $(SRC)` invocation does both at once, so it needed no
such split) — this matters now that `-fno-exceptions` is in the shared file: a codegen flag
like that has to reach each translation unit's compile command, not just the link command,
or it's a silent no-op. (The `-s KEY=VALUE` settings are harmless — and expected — no-ops at
compile time; ignore the `linker setting ignored during compilation` warnings CMake's build
prints for those.) The `file(STRINGS ...)` read of this file also needs `ENCODING UTF-8`:
without it, CMake's byte-oriented `strings`-style reader treats the em-dash in this file's
header comment as a line terminator and leaks the comment's remainder in as a bogus flag.

`cpp/emscripten.flags` carries the flags shared by both `wasm` and `wasm-dbg`: `--bind`,
`MODULARIZE=1`, `EXPORT_NAME=SimCore`, the required `EXPORTED_RUNTIME_METHODS`,
`ALLOW_MEMORY_GROWTH=1`, `INITIAL_MEMORY=16777216` (16 MB), `ENVIRONMENT=web`,
`NO_EXIT_RUNTIME=1`, `MALLOC=emmalloc`, `FILESYSTEM=0` (this module never `fopen`s at
runtime), and `-fno-exceptions -s DISABLE_EXCEPTION_CATCHING=1` (every plant is already
noexcept-style) — confirmed clean of `ASSERTIONS`/`SAFE_HEAP` (those are added only by
the `wasm-dbg` / `npm run wasm:build-debug` target below, on top of `-O0 -g`, never by the
release `wasm` / `npm run wasm:build` path, which uses `-O3`). See "SIMD, LTO,
`FILESYSTEM=0`, exceptions — evaluated" below for what else was measured and why SIMD/LTO
didn't land.

**`npm run wasm:build` vs `npm run wasm:build-debug`:** use the release build
(`wasm:build`, `-O3`, no assertions) for anything that ships — it's what CI commits to
`src/public/wasm/` and what `npm run build` / `build:site` consume. Use the debug build
(`wasm:build-debug` → `sim_core_dbg.js`, `-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1`, DWARF
source maps) only locally, when tracking down a WASM-side crash or memory-safety issue —
it is slower and never committed.

**Required `EXPORTED_RUNTIME_METHODS`** for `src/wasm/seg-physics-bridge.ts` and `sim.ts`:

| Method | Used for |
|--------|----------|
| `ccall` | Low-level C calls (legacy / tooling) |
| `cwrap` | Low-level C calls (legacy / tooling) |
| `HEAPF32` | Zero-copy `Float32Array` views of particle + roller buffers |
| `HEAPU8` | Byte-level heap access when needed by bridges / future tooling |

**Particle layouts** (see also `docs/PHYSICS_CONSTANTS.md`):

| Struct | Bytes | Floats | Consumer |
|--------|-------|--------|----------|
| `GpuParticle` | 16 | 4 (vec3 + phase) | WebGPU compute / billboards |
| `SimParticle` | 32 | 8 (x,y,z,phase,vx,vy,vz,aux) | C++ `sim_core`, WASM export |

`getParticleFloatCount()` returns `_numParticles × 8`. Native smoke seeds 1000 particles
(`getParticleFloatCount == 8000`).

**Roller export:** packed as **4 floats per roller** (`ROLLER_EXPORT_STRIDE`): angle, omega,
radius, height. `getRollerStateFloatCount()` returns `_numRollers × 4` (default topology:
66 rollers → 264 floats). Call `packRollerState()` before reading the buffer.

**Heap growth:** `-s ALLOW_MEMORY_GROWTH=1` is enabled. Any `HEAPF32` / `HEAPU8` view becomes
stale after the WASM heap grows — `sim.ts` re-fetches `mod.HEAPF32` on each
`getParticleFloatView()` / `getRollerStateFloatView()` call.

### Release build flags — what maps to what

The release (`make wasm` / `npm run wasm:build`) target passes flags beyond `emscripten.flags`
directly on the `em++` command line, since they're release-only (the opposite of what
`wasm-dbg` needs) and shouldn't leak into the shared/debug flag set:

| Flag | Where | Effect on output |
|------|-------|-------------------|
| `-O3` | Makefile / CMakeLists.txt | LLVM + Binaryen codegen optimized for speed; already applied outside `emscripten.flags` (unchanged by this doc) |
| `-g0` | Makefile `wasm` target, CMakeLists.txt | Strips DWARF / debug info and disables `-g1`-preserved JS whitespace. No-op if the source was already debug-info-free (this repo never passes `-g` on the release path), but pins the intent explicitly so a future `-g` added elsewhere doesn't leak into `sim_core.js` |
| `--closure 1` | Makefile `wasm` target, CMakeLists.txt | Runs Closure Compiler (`ADVANCED_OPTIMIZATIONS`) over the JS glue: dead-code elimination, renaming, whitespace removal. This is the single biggest lever on `sim_core.js` size — measured **~55% smaller raw / ~32% smaller gzip** on the glue file alone (57.0 KB → 25.7 KB raw; 14.3 KB → 9.7 KB gzip). Requires a working Closure Compiler on `PATH`/reachable via npm — `mymindstorm/setup-emsdk` (used by `.github/workflows/build-wasm.yml`) provides one; a bare distro `emscripten` package may need `npm install -g google-closure-compiler` and `CLOSURE_COMPILER` set in `~/.emscripten` |
| `-s MALLOC=emmalloc` | `emscripten.flags` (shared — safe for both `wasm` and `wasm-dbg`) | Swaps the default `dlmalloc` for the much smaller single-threaded `emmalloc` allocator. This build is single-threaded (`ENVIRONMENT=web`, no pthreads), so emmalloc's lack of thread-safety and coarser fragmentation behavior cost nothing here. Measured **~10% smaller raw / ~9% smaller gzip** on `sim_core.wasm` alone (54.3 KB → 48.7 KB raw; 23.9 KB → 21.8 KB gzip) |

**Combined effect** (measured against the previously-committed `src/public/wasm/` artefacts,
Emscripten 3.1.6 + a Closure Compiler build from the same era):

| Artefact | Before (gzip) | After (gzip) | Δ |
|----------|---------------|--------------|---|
| `sim_core.js` | 13,987 B | 9,732 B | −30.4% |
| `sim_core.wasm` | 24,761 B | 21,781 B | −12.0% |
| **Combined** | **38,748 B** | **31,513 B** | **−18.7%** |

Exact percentages will vary with the Emscripten/Closure Compiler/Binaryen versions used for a
given build (`build-wasm.yml` pins `3.1.61`, newer than what produced the numbers above), but
the combined reduction comfortably clears a 15% target on every toolchain tested.

### SIMD, LTO, `FILESYSTEM=0`, exceptions — evaluated

Six more candidate flags were prototyped and measured against the `-O3 -g0 --closure 1`
release build above (same source, same toolchain, only the flag under test changed). Two
landed in `emscripten.flags`; two were rejected for not clearing their bar; one was skipped
because its precondition doesn't hold yet; native warnings were enabled separately.

| Flag | Verdict | Measured effect |
|------|---------|------------------|
| `-s FILESYSTEM=0` | **Landed** (shared `emscripten.flags`) | This module never `fopen`s at runtime (`ENVIRONMENT=web`, no file I/O in `plant/*.cpp`), so the emulated filesystem shim is dead weight. Combined with `-fno-exceptions` below: **32,690 B → 32,282 B** combined gzip (**−1.2%**). Zero risk, zero runtime cost — landed even though `--closure 1`'s dead-code elimination already strips most of the unused FS glue, because it documents the intent explicitly and the saving holds even on a non-Closure (`wasm-dbg`) build |
| `-fno-exceptions` + `-s DISABLE_EXCEPTION_CATCHING=1` | **Landed** (shared `emscripten.flags`) | `plant/*.cpp` and `sim_core_*.cpp` contain no `try`/`catch`/`throw` — every plant is already noexcept-style. Disabling exception support removes the unwind tables and landing pads Binaryen otherwise has to keep around. Measured **`sim_core.js` 25,706 B → 25,309 B raw (−1.5%)**, **`sim_core.wasm` 51,698 B → 51,151 B raw (−1.1%)** |
| `-msimd128` (`wasm` / `wasm-dbg`) | **Rejected** | RK4 roller stepping and particle CPU replay don't auto-vectorize into a size or speed win here: `sim_core.wasm` grew **51,698 B → 55,301 B raw (+7.0%)** (wider SIMD opcodes, code the roller/particle loops don't exploit), while step throughput was flat within run-to-run noise (SEG RK4 step/s and particle step/s both **±1–2%** across repeated Node-harness runs — no consistent gain). Rejected: it only adds bytes without a measurable step/s win. `wasm-dbg` was confirmed to still compile with `-msimd128` in case a future plant makes this worth revisiting. (Browser support was not the blocker — WebGPU already sets a Safari 16.4+ / Chrome 91+-or-newer floor for this lab, which comfortably covers `-msimd128`'s own requirement.) |
| `-flto` (release `em++`) | **Rejected** | `sim_core.wasm` was flat (**51,698 B → 51,722 B raw**, ~0%) — nowhere near the ≥10% size or ≥15% step/s bar this issue set. Worse, the particle-replay throughput was **consistently ~5% slower** with LTO across three repeated runs (RK4 roller step/s unaffected). Given a flat size result and a repeatable regression on one of the two benchmarked paths, `-flto` is rejected rather than landed as a wash |
| `-s WASM_BIGINT=1` | **Skipped** | Only useful once a `u64` counter crosses the JS `Number` boundary. Nothing in `sim_core_embind.cpp`'s current bound surface returns/accepts `u64` — revisit if that changes |
| `make native`: `-Wall -Wextra -Wpedantic` | **Landed** | `plant/*.cpp` and `sim_core_*.cpp` already build warning-free under `g++`/`clang++` `-std=c++17 -O2 -Wall -Wextra -Wpedantic` — no code changes were needed. Not `-Werror` yet (per this issue's scope: no drive-by hardening beyond what's already clean) |

Measured with a distro-packaged Emscripten 3.1.6 + a version-matched `google-closure-compiler`
(the CI-pinned 3.1.61 in `build-wasm.yml` was unavailable in the measurement environment);
absolute byte counts will shift slightly under 3.1.61, but the relative deltas that drove each
verdict — SIMD/LTO not clearing their bar, `FILESYSTEM=0`/no-exceptions being small free wins —
are toolchain-independent enough to act on. `cpp/build/sim_core_test --mode bench` (`npm run
wasm:native`) prints `bench_seg_steps_per_sec=<N>` / `bench_particle_steps_per_sec=<N>` so CI
and local runs can track step-rate regressions from future flag changes without needing a
browser or a WASM harness.

Zero-copy contract re-verified after this change: `mod.HEAPF32` / `mod.HEAPU8` are still
exported and instantiate correctly with both new flags enabled (checked via a Node harness
loading the built `.wasm` directly with `Module.wasmBinary`, bypassing the `ENVIRONMENT=web`
fetch path).

Rejected for reasons unrelated to measurement, per this issue's explicit scope: `-sSHARED_MEMORY`
/ pthreads (this build is single-threaded — `ENVIRONMENT=web`, `emmalloc`, ADR-0002), Eigen/ODE
libraries (`Vec3` + per-plant ODEs are the right size for this codebase), and `wasm64` /
memory64 (not ready for this ABI).

### `SINGLE_FILE` — evaluated, not enabled

`-s SINGLE_FILE=1` embeds `sim_core.wasm` as a base64 data URI inside `sim_core.js`, removing
the second network request. It was evaluated and **not enabled**:

- Base64 inflates the wasm payload by ~33% before compression; gzip claws back most but not
  all of that, so `SINGLE_FILE=1` produces a *larger* combined transfer than two separate
  files (measured: 39,530 B gzip as one merged file vs. 31,513 B combined gzip for the two
  files above — SINGLE_FILE is ~25% larger over the wire).
- `src/public/wasm/` is a **prebuilt, committed** artefact (built once by CI, served statically
  by GitHub Pages) — it is not rebuilt per request, so the "one fewer HTTP request" ergonomic
  win `SINGLE_FILE` targets doesn't apply to a static host the way it would to a
  server-rendered or frequently-rebuilt app.
- Two files let the browser cache `sim_core.wasm` (which almost never changes) independently
  of `sim_core.js` (which changes whenever `EXPORTED_RUNTIME_METHODS` or bindings change).

If a future use case needs a single-file embed (e.g. a standalone offline build), add
`-s SINGLE_FILE=1` to a dedicated Makefile target rather than the default `wasm` release path.

### Debug WASM build

```bash
npm run wasm:build-debug
# → src/public/wasm/sim_core_dbg.js (with DWARF debug info)
```
## File Structure

```
cpp/
  emscripten.flags   ← shared Emscripten link flags (Makefile + CMake)
  src/
    sim_core.h           ← Vec3, SimParticle, SEGRollerState, SEGSimulator API
    sim_core_facade.cpp  ← ctor, mode dispatch, cross-mode accessors
    sim_core_embind.cpp  ← Emscripten / Embind surface (WASM only)
    sim_core_standalone.cpp ← native smoke-test driver + CSV export
    plant/
      plant_common.h        ← shared helpers (clampf, hash1/rnd, lcg, Swamee–Jain f)
      heron_plant.h/.cpp    ← HeronState + Bernoulli / Swamee–Jain
      kelvin_plant.h/.cpp   ← KelvinState + capacitive spark
      solar_plant.h/.cpp    ← SolarState + LED/solar battery SOC
      peltier_plant.h/.cpp  ← PeltierState + thermoelectric stack
      mhd_plant.h/.cpp      ← MHDState + Hartmann channel
      maglev_plant.h/.cpp   ← MaglevState + gap ODE
      homopolar_plant.h/.cpp ← HomopolarState + Faraday disc
      transformer_plant.h/.cpp ← TransformerState + coupled-inductor L–M
      vdg_plant.h/.cpp      ← VdgState + belt-charge/spark-gap ODE
      hall_plant.h/.cpp     ← HallState + I·B → Hall voltage
      lorentz_plant.h/.cpp  ← LorentzState + rail sled
      energy_network.h/.cpp ← lab energy bus structs (ADR-0004 Phase B)
      seg_plant.cpp         ← magnetic-field utilities + SEG roller RK4
      chores_reduce.cpp     ← GPU-chores CPU reduce fallback
      particles.cpp         ← mode-aware particle seed/step + accessors
  CMakeLists.txt     ← CMake / Emscripten + CMAKE_EXPORT_COMPILE_COMMANDS
  Makefile           ← make wasm / native / compile-db ($(wildcard src/plant/*.cpp))
  build/             ← native CMake + sim_core_test (gitignored except README.md)
```

Each `plant/*.cpp` implements a subset of `SEGSimulator`'s private `_step*`
methods plus that mode's free functions declared in `sim_core.h`; the
Emscripten `--bind` class name (`SimCore`/`SEGSimulator`) and its public
method surface are declared in `sim_core_embind.cpp`; plant physics lives in
this split. See `docs/MODE_MATRIX.md` (generated from `physics/devices.json`)
for `shaderMode` vs `wasmMode` — they are two namespaces, not one.

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
  `getParticle(i)`. JavaScript side (via `seg-physics-bridge.ts` and `sim.ts`)
  can now pull the high-precision CPU particle state for seeding or diffing
  against the WebGPU side.
- **Multi-mode plants**: `setMode(0..11)` / `getMode()` (see `wasmMode` in
  `physics/devices.json`). 0 = SEG (full RK4 roller path), 1 = Heron (Bernoulli /
  Swamee–Jain), 2 = Kelvin (capacitive + spark), 3 = Solar (battery SOC),
  4 = Peltier (two-node Seebeck stack), 5 = MHD (Hartmann channel),
  6 = Magnetic Levitation (Quanta gap ODE), 7 = Homopolar Generator (Faraday
  disc L–R), 8 = Mutual Induction / transformer (coupled-inductor L–M),
  9 = Van de Graaff (belt-charge/leakage/spark-gap ODE), 10 = Hall-Effect Bench
  (algebraic I·B → Hall voltage), 11 = Lorentz Rail Sled (rail-motor R–L +
  back-EMF + Lorentz force vs friction). Every mode has real dynamics, mode-aware
  particle seeding/stepping, and dedicated telemetry getters. Pulse Coil and
  the Halbach field visualizer stay JS-only (`wasmMode: null`) — no C++ plant.
- **Per-ring load torque**: `setRingLoadTorque(ring, t)`, `setRingLoadTorques(t0, t1, t2)`,
  and `stepWithPerRingTorques(dt)`. The original `step(dt, loadTorque)` continues
  to broadcast its value to all rings (identical prior behaviour).

Thin JS wrappers live in `src/wasm/seg-physics-bridge.ts` and `src/wasm/sim.ts`
so the debug panel and future consumers can call the new functionality directly.

Since implemented: real dynamics for all twelve WASM-backed modes (Heron,
Kelvin, Solar, Peltier, MHD, Magnetic Levitation, Homopolar Generator,
Mutual Induction, Van de Graaff, Hall-Effect Bench, and Lorentz Rail Sled
alongside SEG),
zero-copy particle + roller buffers, and mode-aware particle seeding / stepping.

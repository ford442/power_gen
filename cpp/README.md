# cpp/ – SEG Simulation Core (C++ → WebAssembly)

This directory contains a C++20 simulation core that compiles to WebAssembly
(WASM) using Emscripten. It provides high-performance, high-precision CPU-side
physics that complements the WebGPU compute shaders:

| Feature | GPU (compute.wgsl) | WASM (`cpp/src/sim_core_*.cpp` + `plant/`) |
|---|---|---|
| Particle system | ✅ 10–50k real-time | ✅ CPU-side replay |
| SEG roller dynamics | Semi-implicit Euler | **RK4 integrator** |
| Shared ODE integrators | — | **rk4 / dopri5 / ros23** (`src/core/integrate.h`) |
| FDTD TM_z slice | ✅ 256² compute pass | ✅ CPU kernel (WebGL2 micro-grid, `?wasmPhysics=1`) |
| Magnetic field | Approximated | Exact dipole formula |
| Double-precision | ❌ f32 only | ✅ f64 possible |
| Off-screen/export | ❌ | ✅ |

## Quick Start

### Prerequisites

Install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html):

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install "$(cat ../cpp/emsdk-version)"    # the one pin: cpp/emsdk-version (3.1.61)
./emsdk activate "$(cat ../cpp/emsdk-version)"
source ./emsdk_env.sh
```

`cpp/emsdk-version` is read by `scripts/build-wasm.sh` (warns when `emcc` differs) and by
`build-wasm.yml`'s `setup-emsdk` step. Bump it there and nowhere else.

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

Output: `src/wasm/sim-core/sim_core.wasm` — one standalone reactor module, **no JS glue**
(#254 §3; see [WASM ABI](#wasm-abi--zero-copy-contract)). **This `make wasm` path is the only
one that produces the committed binary** (CI and Pages ship it). `src/wasm/index.ts`
references it: Vite emits the `.wasm` under a content-hashed name, and the lazy
`sim-core/instantiate.ts` chunk instantiates it.

`make wasm` also bakes `sim_core_source_hash()` — `scripts/sim-core-source-hash.mjs` over
`cpp/src/**`, `generated/*.h`, `emscripten.flags`, `Makefile`, `emsdk-version` — into the
binary. The site build defines the same hash, so a stale shipped binary is visible: the WASM
header badge turns amber with the reason on hover, `test:wasm-abi` warns, and
`build-wasm.yml`'s fresh build fails if they differ.

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
./build/sim_core_test --mode jumping-ring # Thomson ring coupled L–M(h) + mass/gravity smoke
./build/sim_core_test --mode chores      # gpu-chores reduce/map goldens
./build/sim_core_test --mode catalog     # print id → wasmMode; fail on holes/dupes
./build/sim_core_test --mode bench       # bench_* throughput lines (SEG, particles, ring per integrator, FDTD)
./build/sim_core_test --mode golden      # dual-plant telemetry goldens (see below)
./build/sim_core_test --mode snapshots   # plantSave → plantLoad → step bit-identical, every mode
./build/sim_core_test --mode integrators # every integrator vs the reference it replaced + analytic checks
./build/sim_core_test --mode fdtd        # FDTD TM_z kernel: finite under drive, sponge absorbs
```

`--mode golden` replays every **dual** device — one with a `wasmMode` *and*
a TypeScript fallback plant — from a fixed seed and prints the schedule it
used plus its catalog telemetry keys:

```
golden.case peltier drive=0.85 frames=240 dt=0.016666667…
golden.value peltier peltierHotK 297.93249511718750
```

`npm run test:golden` (part of `npm run validate`) steps the TS fallback
over exactly that schedule and diffs all 91 keys (every shared-integrator plant once per method) — see
[`docs/PHYSICS_CONSTANTS.md`](../docs/PHYSICS_CONSTANTS.md#js--wasm-golden)
for the ε and what a failure means. The native run is authoritative for
drive / frames / dt, so a case is added here, not in the Node script.

Plant modes (SimMode enum): `0=SEG` RK4 rollers, `1=Heron` Bernoulli /
Swamee–Jain, `2=Kelvin` capacitive + spark, `3=Solar` battery SOC,
`4=Peltier` simplified 1D Seebeck/Peltier two-node stack (Thomson neglected),
`5=MHD` Hartmann-style channel flow with Lorentz braking and induced load
voltage, `6=Maglev` spring–damper gap ODE (mirrors Quanta JS),
`7=Homopolar` Faraday disc L–R + back-EMF (mirrors Quanta JS),
`8=Transformer` coupled-inductor RK4 ODE (the TS fallback is a term-for-term
port of it, not a phasor approximation),
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
paths (`-DSIM_CORE_STANDALONE`, `-I src`, `-Wall -Wextra -Wpedantic
-Werror` — the same flags the Makefile's `native` target uses) so clangd
can jump from `plant/vdg_plant.cpp` into `VdgState` / `SEGSimulator`:

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

`sim_core_abi.cpp` (the generated C ABI) is in the native source list too:
`EMSCRIPTEN_KEEPALIVE` is empty there, so `make native` type-checks every
export against `sim_core.h` under `-Werror` and the native database covers
every file.

#### WASM compile database (optional)

```bash
# needs emcmake on PATH (source emsdk_env.sh)
make -C cpp compile-db-wasm     # → cpp/build-wasm/compile_commands.json
```

Only needed to see the wasm32 target's view (`__wasm__`, the emsdk sysroot,
`<emscripten/emscripten.h>`); start clangd with `--query-driver=**/em++` to use
it. The Emscripten CMake configuration is a **compile database only**: its
objects compile with the release `-O3` so the database matches reality, but the
link step refuses to run (a `PRE_LINK` command fails with a pointer to
`make -C cpp wasm`) and its output directory is `build-wasm/not-shipped/`, so an
unoptimised CMake build can never overwrite the committed `sim_core.wasm`.
`cpp/build-wasm/` is gitignored.

### Sanitizers (ASan + UBSan)

```bash
npm run wasm:native:san            # probe a toolchain, then make -C cpp native-san
SAN_CXX=clang++ npm run wasm:native:san
SAN_REQUIRED=1 npm run wasm:native:san   # fail instead of skip
```

`make native-san` builds `build/sim_core_test_san` from the same `NATIVE_SRC`
and `-Wall -Wextra -Wpedantic -Werror` bar as `make native`, with
`-fsanitize=address,undefined -fno-sanitize-recover=undefined`, then runs the
default smoke, `--mode golden`, `--mode jumping-ring`, `--mode energy-network`,
`--mode integrators` and `--mode fdtd` with leak detection on. Any report is fatal.

`scripts/native-san.sh` first compiles **and runs** a tiny probe with each of
`$SAN_CXX`, `clang++`, `g++`: a distro clang without compiler-rt (common —
Ubuntu's `clang` package does not pull `libclang-rt-*-dev`) fails the link and
is skipped in favour of g++ with libasan/libubsan. If no toolchain passes, the
script prints why and exits 0, so gcc-only / minimal CI images are not turned
red; `validate.yml` runs it in its `native-san` job (the native smoke itself
runs inside `npm run validate`).

### clang-tidy (advisory)

```bash
make -C cpp compile-db tidy
```

`cpp/.clang-tidy` enables `bugprone-*` (minus swappable-parameters /
narrowing-conversions), `modernize-use-nullptr` and two `performance-*`
copy checks — no `readability-magic-numbers`, which would flag every physical
constant in the plants. `WarningsAsErrors` is empty and `make tidy` never fails;
at the time of writing it reports 4 findings (2 reserved-identifier, 1
switch-missing-default-case, 1 implicit-widening). Promote it to CI with
`-Werror` only once that count is near zero.

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

### Shared integrators (`src/core/`)

`core/plant.h` is the `sim_core::Plant` concept a bench implements to run on
the shared integrators instead of a hand-written substep loop: `state_size`,
`input_type` (held constant over one advance), `derivs(t, x, u, dxdt)`,
`outputs(x, u, y)` and `save` / `load` between the plant struct and the flat
`std::span<float>` x. A `ConstrainedPlant` adds `constrain(x)` (rigid stops,
sign clamps), applied after every accepted step. `core/integrate.h` holds:

| Method | What | Carry-over |
|--------|------|------------|
| `euler_fixed` | one explicit Euler step | — |
| `rk4_fixed` | one classical RK4 step, in the expression order the hand-written plants used — porting a plant onto it is bit-identical | — |
| `dopri5_advance` | adaptive Dormand–Prince 5(4), PI step control, **dense output**: the step that crosses the frame end runs to completion and the frame-end state is interpolated, so a frame boundary never forces a short step | `StepperState{h, errOld}` |
| `ros23_advance` | Shampine's L-stable Rosenbrock (2,3) (`ode23s`), forward-difference Jacobian (#257 swaps it for duals) | `StepperState{h, errOld}` |

The method is a catalog field — `physics/devices.json` `"integrator"` plus an
`"ode"` block (state names in index order, outputs, tolerances) — codegen'd into
`generated/plant-ode.h` (constexpr state-index enums, `tolerance()`) and
`generated/plant-ode.ts`. `SEGSimulator::setIntegrator(m)` overrides it for
benches and goldens. Ported: **homopolar** (`euler`, its historical scheme) and
**jumping-ring** (`dopri5`). The TS twin is `src/renderers/shared/integrate.ts`.
Full write-up, numbers and "how to port a plant": [`docs/INTEGRATORS.md`](../docs/INTEGRATORS.md).

`--mode integrators` (and `npm run test:integrators`) compares every method
against the reference it replaced. Jumping ring on its 400 × 1/90 s golden
schedule (err = max over frames of |x − ref| / max |ref|, per channel):

| Method | RHS calls | vs 20k-substep RK4 | worst channel err |
|--------|-----------|--------------------|-------------------|
| rk4 (reference) | 356,800 | 1× | — |
| **dopri5 (catalog)** | **33,975** | **10.5×** | 2.5e-4 (ring current; others ≤ 3.1e-5) |
| ros23 | 78,393 | 4.6× | 1.3e-3 |

The leakage loop (τ ≈ 0.33 ms) caps any explicit method near h ≈ 1 ms, which
is why dopri5 tops out around 10–12×; ros23 is accuracy-limited (second
order) on the 60 Hz drive rather than stability-limited.

### WASM ABI / zero-copy contract

**No Embind, no JS glue** (#254 §3). The JS ⇄ WASM surface is one manifest,
`cpp/abi.json`, and `npm run codegen:wasm-abi` (`scripts/codegen-wasm-abi.mjs`)
emits all of it:

| Output | What |
|--------|------|
| `cpp/src/sim_core_abi.cpp` | `extern "C" EMSCRIPTEN_KEEPALIVE` shims, scalars in / scalars out |
| `src/wasm/sim-core/abi.generated.ts` | `SimCoreExports` (typed `instance.exports`) + `bindSimCore()` → the `SimCoreModule` the app uses (`new mod.SEGSimulator()`, `mod.FdtdTmzGrid`, free functions, `HEAPF32`) |
| `generated/sim-core-exports.json` | `EXPORTED_FUNCTIONS` for the link |

`src/wasm/sim-core/instantiate.ts` (hand-written) instantiates the bare module,
runs `_initialize`, and supplies its only two imports:
`env.emscripten_notify_memory_growth` (no-op: the wrappers rebuild their heap
views lazily) and `wasi_snapshot_preview1.clock_time_get` (the particle RNG's
`std::time` seed). `npm run test:wasm-abi` diffs the shipped binary's export
table against the manifest both ways, checks its imports are exactly what the
loader provides, and calls every export. A signature drift fails `make native`
(the shim compiles natively too); a stale binary fails the diff — neither can
reach the frame loop as a `TypeError`. Manifest format and conventions:
[`docs/WASM_ABI.md`](../docs/WASM_ABI.md).

Struct returns (`Vec3`, `SimParticle`, `ChoresReduceResult`, energy-bus
summaries) are copied into one static 16-float block whose address is returned;
the wrapper reads it back immediately. `bool` is an `i32`, `ptr` / `u32` come
back `>>> 0`, strings are NUL-terminated UTF-8. Array arguments (`f32[]`:
`setNetworkEdges`, `FdtdTmzGrid.setSources` / `setMaterials`) are staged by the
wrapper in the class's C++-owned scratch, then passed as pointer + count:

| Rate | Pattern | Exports |
|------|---------|---------|
| Low (once per enable) | `f32[]` arg, staged by the wrapper | `setNetworkEdges`, FDTD `setMaterials` |
| Per frame | C++-owned scratch: `getScratchPtr(n)` → `HEAPF32.set(arr, ptr >> 2)` → `…FromScratch(n)` (re-read `HEAPF32` *after* the ptr call — the resize may grow the heap) | `updateEnergyNetworkFromScratch`; `chores_scratch_ptr` + `chores_*_scratch`; FDTD `setSources` |

**Glue size** (the JS that crosses the boundary): Embind `sim_core.js`
22,582 B raw / 9,157 B gzip → the generated wrappers + loader chunk
(`instantiate-*.js` in a site build) **10,084 B raw / 2,598 B gzip (−72 %)**,
covering 142 exports (the Embind glue covered 118). The `.wasm` lost Embind's
class registry too (83,332 → 68,135 B before the FDTD kernel landed, same
sources).

**`EXPORTED_RUNTIME_METHODS`, `MODULARIZE`, `DYNAMIC_EXECUTION`,
`--closure`, `SINGLE_FILE`** are gone with the glue: there is no Emscripten JS
to configure. The module has no `eval` / `new Function` path at all, so a
strict CSP (`script-src 'self' 'wasm-unsafe-eval'`) holds.

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

**Heap growth:** `-sALLOW_MEMORY_GROWTH=1` is enabled. A `Float32Array` over
`memory.buffer` detaches when the heap grows — read `mod.HEAPF32` again after
any call that may allocate (`sim.ts` re-fetches it on each
`getParticleFloatView()` / `getRollerStateFloatView()`; `WasmFdtdTmzGrid`
rebuilds its field views when the buffer changes).

### Plant snapshots (`plantSave` / `plantLoad`)

Every mode's plant can be saved to and restored from a float vector —
`[_time, _drive, …fields]`, the fields listed by the device's `state` block in
`physics/devices.json` (#224 §2, [`docs/SNAPSHOTS.md`](../docs/SNAPSHOTS.md)).
The methods are codegen'd into `generated/plant-state-impl.h` and compiled by
`src/plant/plant_state.cpp`, so a layout change is a catalog edit plus
`npm run codegen:catalog`, never a hand-written serializer. A shared-integrator
plant also saves its adaptive stepper's `stepH` / `stepErrOld` (the catalog
codegen refuses an `ode` block without them), so a restored plant steps on
bit-identically under any method.

| Method | Contract |
|--------|----------|
| `int plantStateSize(int mode) const` | floats in `mode`'s vector (`PLANT_STATE_SIZES`; 0 if unknown) |
| `int plantSave(int mode)` | writes the vector into the float scratch (`getScratchPtr`), returns its length |
| `bool plantLoad(int mode, int count, uint32_t layoutHash)` | reads `count` scratch floats; refuses a `layoutHash` ≠ `PLANT_STATE_LAYOUT_HASH`, a wrong `count`, a too-small scratch or any non-finite value — the plant is left untouched |

C ABI: the three class methods plus the free `plant_state_layout_hash()`. The
same scratch pattern as the energy bus (table above): `plantSave(m)` →
`getScratchPtr(n)` → read `HEAPF32`; or `HEAPF32.set(v, ptr >> 2)` →
`plantLoad(m, n, hash)`. `--mode snapshots` (in the default native run) and
`npm run test:snapshots` (shipped WASM, in Node) hold every mode to a
bit-identical save → load → step, compared every frame.

### Compile-flag study (#254 §4, emsdk 3.1.61, 2026-11)

Every candidate was a full release build of the same sources, timed through the
real ABI by **`npm run bench:wasm -- <file.wasm>`** (`scripts/bench-wasm.mjs`,
Node 22 / V8 — Chrome's engine — so JS→WASM call overhead is in the numbers)
next to the native `--mode bench`. The VM was noisy (±10 % run to run). Rows
marked \* are one pass (median of 5 runs); the deciding pair — `-O3` and the
shipped build — is the median of three interleaved passes × 7 runs, and the
SIMD / LTO effects below were each seen in at least two passes. Only effects
that repeated are claimed.

`seg` = `SEGSimulator.step` calls/s (one ABI call each); `particles` =
2000-particle `stepParticles`/s; `ring` = jumping ring simulated seconds per
wall second on each integrator; `fdtd` = 256² cell updates/s with a material
map.

| Build | `.wasm` raw / brotli | seg | particles | ring rk4 | ring dopri5 | ring ros23 | fdtd |
|---|---|---|---|---|---|---|---|
| `-O3` (before) | 75,022 / 32,048 B | 542k | 3,073 | 429 | 2,880 | 964 | 84 M |
| `-O3 -msimd128` \* | 84,549 / 34,735 B | 557k | 3,178 | 394 | 2,728 | 855 | 244 M |
| `-O3 -flto` \* | 72,222 / 31,076 B | 536k | 3,202 | 497 | 2,762 | 909 | 87 M |
| `-O3 -flto -msimd128` \* | 81,773 / 33,535 B | 553k | 3,043 | 412 | 2,666 | 884 | 240 M |
| `-O2` \* | 73,884 / 32,355 B | 551k | 3,253 | 394 | 2,834 | 968 | 88 M |
| `-Os` \* | 71,243 / 30,418 B | 557k | 3,222 | 215 | 1,865 | 581 | 88 M |
| `-Oz` \* | 65,190 / 28,787 B | 417k | 3,112 | 204 | 1,809 | 547 | 83 M |
| `-O3` + `wasm-opt -O3 --converge` \* | 74,991 / 32,089 B | 564k | 3,232 | 427 | 2,915 | 962 | 88 M |
| **`-O3 -flto` + FDTD `target("simd128")` (shipped)** | **74,134 / 31,569 B** | **545k** | **3,132** | **500** | **2,885** | **909** | **234 M** |

What landed, in `cpp/emscripten.flags` (and why):

- **`-flto`**: 1.2 % smaller (3.7 % without the SIMD kernel) and **+17 % on the
  ring's RK4 path** in every pass. Not profiled; the likely source is the
  LTO-built libm (`expf`, `sin`) inlining into the ring's RHS, since
  `rk4_fixed` and `ThomsonPlant::derivs` already share a TU. ros23 is −6 % (no
  plant defaults to it). Plain `-O3 -flto` also cost particles 4–6 % in two
  passes — the regression the pre-#254 study rejected LTO for — but the
  shipped combination does not repeat it (3,132 vs 3,073 steps/s), so it lands.
- **Wasm SIMD on the FDTD kernel only** (`__attribute__((target("simd128")))`
  on `FdtdTmzGrid::_stepOnce`, `cpp/src/plant/fdtd_tmz.cpp`): **2.8×** on the
  kernel (84 M → 234 M cell updates/s), clang auto-vectorising the SoA inner
  loops into `f32x4` (divide included). **Module-wide `-msimd128` is
  rejected**: it buys the same 2.8× on FDTD but costs the ring 6–11 % on every
  integrator in both passes (not profiled — presumably the fixed 4-state loops
  vectorise badly) and adds 9.5 KB. Every
  WebGPU-capable browser ships Wasm SIMD, so the feature itself is free.
- **`particles.cpp` is not vectorised**, by design: `SimParticle` is AoS
  because it *is* the zero-copy layout the GPU path reads (32 B, mirrors the
  WGSL struct), and each particle costs a mode switch plus `sin` / `cos` with
  no vector libm. Neither `-msimd128` nor LTO moves it beyond noise; an SoA
  rewrite plus a polynomial vector sin/cos is not worth it at 0.3 ms per
  2000-particle step.

Rejected: **`-Oz` / `-Os`** (−13 % / −5 % size, but the ring runs at half
speed and `-Oz` costs `seg` 23 %); **`-O2`** (no win over `-O3`); **an extra
`wasm-opt -O3 --converge` / `-Oz` pass** (byte-for-byte noise: emcc already
runs Binaryen at the link's `-O` level); **`-ffast-math`** (not measured on
purpose — it would let the compiler reassociate the plants' float arithmetic
and move every golden).

**`INITIAL_MEMORY` = 4 MiB, confirmed.** `bench:wasm` records
`memory.buffer.byteLength` after each workload: the SEG plant, a
50,000-particle seed (the `MAX_PARTICLES` cap), the largest snapshot
(SEG, 137 floats) and a 256² FDTD grid with a material map (10 float fields
plus the 128k-float staging scratch, ≈ 3.1 MB) all stay inside 4,194,304
bytes — no growth. (The WebGL2 micro-grid is 64², ~0.2 MB.)

**Regression tracking.** The shipped row is recorded in
`cpp/bench-baseline.json`; `build-wasm.yml` runs
`npm run bench:wasm -- --baseline=cpp/bench-baseline.json` on every fresh
build — a binary > 5 % larger fails (size is deterministic under the pinned
emsdk), a throughput below 0.6× the baseline is an Actions warning (runners
differ, but losing the SIMD kernel lands at 0.37× and shows). Re-baseline on
purpose, numbers in the PR.

**Threads (`-pthread`, `SharedArrayBuffer`): not pursued.** The issue gates them
on this study showing a single thread is the bottleneck for sweeps, and it does
not: on its catalog integrator the jumping ring runs ~2,900 simulated seconds
per wall second, so an offline sweep of 100 × 10 s runs is ~0.35 s of plant
time on one core. Pages cannot send COOP/COEP, so threads would also need
service-worker header injection — an ADR's worth of risk for no measured need.
No ADR written.

#### Earlier measurements (pre-#254, Embind era) that still hold

`-sMALLOC=emmalloc` (~10 % smaller `.wasm` than dlmalloc; single-threaded, so
no cost), `-sFILESYSTEM=0` and `-fno-exceptions` (no file I/O, no
`try` / `catch` in any plant) were measured then and remain in
`emscripten.flags`. The glue-side flags of that era (`--closure 1`,
`EXPORT_ES6`, `DYNAMIC_EXECUTION=0`, `SINGLE_FILE`) no longer apply — there is
no glue. `-sWASM_BIGINT` stays unnecessary: no `u64` crosses the ABI (the
loader's `clock_time_get` writes its `u64` into memory itself).

### Release vs debug build

| Target | Flags (beyond `emscripten.flags`) | Output |
|--------|-----------------------------------|--------|
| `make wasm` / `npm run wasm:build` | `-O3 -g0`, `SIM_CORE_SOURCE_HASH` baked in | `src/wasm/sim-core/sim_core.wasm` (committed) |
| `make wasm-dbg` / `npm run wasm:build-debug` | `-O0 -g` (DWARF; Chrome's C/C++ DevTools extension reads it) | `src/wasm/sim-core/sim_core_dbg.wasm` (never committed) |

`ASSERTIONS` / `SAFE_HEAP` were glue features and went with it; ASan + UBSan on
the native build (`npm run wasm:native:san`) cover memory safety instead.

## File Structure

```
cpp/
  abi.json           ← the JS ⇄ WASM surface (manifest for codegen-wasm-abi)
  bench-baseline.json ← flag-study numbers build-wasm.yml checks against
  emscripten.flags   ← shared Emscripten link flags (Makefile + CMake)
  src/
    sim_core.h           ← Vec3, SimParticle, SEGRollerState, SEGSimulator API
    sim_core_facade.cpp  ← ctor, mode dispatch, cross-mode accessors
    sim_core_abi.cpp     ← GENERATED flat C ABI (cpp/abi.json → npm run codegen:wasm-abi)
    core/
      plant.h               ← sim_core::Plant / ConstrainedPlant concepts
      integrate.h           ← euler / rk4_fixed / dopri5 / ros23 (docs/INTEGRATORS.md)
    sim_core_standalone.cpp ← native driver: main() + CSV export
    standalone/             ← one TU per --mode family (plant smokes, system smokes, golden, bench, integrators)
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
      thomson_plant.h/.cpp  ← ThomsonState + ThomsonPlant (jumping ring, dopri5)
      fdtd_tmz.h/.cpp       ← FdtdTmzGrid: 2D TM_z FDTD CPU kernel (SoA, SIMD)
      energy_network.h/.cpp ← lab energy bus structs (ADR-0004 Phase B)
      seg_plant.cpp         ← magnetic-field utilities + SEG roller RK4
      chores_reduce.cpp     ← GPU-chores CPU reduce fallback
      particles.cpp         ← mode-aware particle seed/step + accessors
      plant_state.cpp       ← compiles generated/plant-state-impl.h (plantSave / plantLoad)
  CMakeLists.txt     ← CMake / Emscripten + CMAKE_EXPORT_COMPILE_COMMANDS
  Makefile           ← make wasm / native / native-san / tidy / compile-db /
                       compile-db-wasm ($(wildcard src/plant/*.cpp))
  .clang-tidy        ← advisory profile (make tidy)
  build/             ← native CMake + sim_core_test (gitignored except README.md)
  build-wasm/        ← emcmake configure for clangd (gitignored)
```

Each `plant/*.cpp` implements a subset of `SEGSimulator`'s private `_step*`
methods plus that mode's free functions declared in `sim_core.h`; what JS
can call is exactly `cpp/abi.json`; plant physics lives in this split. See `docs/MODE_MATRIX.md` (generated from `physics/devices.json`)
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

Low-level access via the module (`SimCoreModule`, generated from `cpp/abi.json`):

```typescript
import { loadSimCore } from './wasm/index';

const mod = await loadSimCore();
if (mod) {
  const B = mod.axialBField(0, 0.05, 0.025, 1.48);
  console.log('Axial B-field:', B, 'T');

  const sim = new mod.SEGSimulator();
  for (let i = 0; i < 600; i++) sim.step(1/60, 0.1);
  console.log('RPM after 10s:', sim.getRPM());
  sim.setMode(12);                   // jumping ring, on its catalog dopri5
  sim.resetOdeStats();
  for (let i = 0; i < 90; i++) sim.step(1/90, 0);
  console.log('RHS calls:', sim.getOdeRhsEvals());
  sim.delete();

  const grid = new mod.FdtdTmzGrid(); // the C++ FDTD kernel
  grid.init(64, 7, 0.5, 0.12, 0.8);
  grid.setSources([32, 32, 1, 1]);
  grid.step(20);
  const ez = new Float32Array(mod.HEAPF32.buffer, grid.ezPtr(), 64 * 64);
  grid.delete();
}
```

## CI

The GitHub Actions workflow `.github/workflows/build-wasm.yml` builds the WASM with the
emsdk from `cpp/emsdk-version` on every push or PR that touches anything compiled into it
(`cpp/`, `src/wasm/`, `generated/*.h`, `generated/sim-core-exports.json`, `physics/`, the
build/codegen scripts). It runs the WASM suites on the fresh binary (`SIM_CORE_REQUIRE_FRESH=1`
makes the source hash a hard check), the size / bench check against
`cpp/bench-baseline.json`, and on `main` commits `sim_core.wasm` back to `src/wasm/sim-core/`. That commit is
`[skip ci]`, so Pages keeps the previous binary until the next deploy; the stale-binary badge
says so meanwhile.

## Next Steps / Roadmap

Recent non-breaking expansions (SEGSimulator API and all prior bindings preserved):

- **Particle buffer export**: the zero-copy `getParticleFloatView()` (8 floats per
  `SimParticle`) or `getParticle(i)`. The old `getParticles()` returned an
  unregistered `std::vector<SimParticle>` and could never be called; it was removed
  in 1.5.0 (`SEGSim.getParticles()` in TS loops `getParticle`).
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

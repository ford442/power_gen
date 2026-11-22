# sim_core WASM ABI

> #254 §3. Replaces Embind (`--bind`) and the Emscripten JS glue.

The boundary used to be Embind: a class registry, hidden `std::vector`
marshalling (#221 froze the lab when that ABI changed), and most of a 22.6 KB
glue file. Every binding already took scalars or a scratch pointer, so the
boundary is now a flat C ABI generated from one manifest:

```
cpp/abi.json ──npm run codegen:wasm-abi──▶ cpp/src/sim_core_abi.cpp            extern "C" shims
  (scripts/codegen-wasm-abi.mjs)        ├▶ src/wasm/sim-core/abi.generated.ts  typed exports + wrappers
                                        └▶ generated/sim-core-exports.json     EXPORTED_FUNCTIONS
```

`make wasm` writes **only** `src/wasm/sim-core/sim_core.wasm`: a standalone
reactor module (`--no-entry`). `src/wasm/sim-core/instantiate.ts` instantiates
it, and `bindSimCore()` wraps `instance.exports` into the `SimCoreModule` the app
has always used (`new mod.SEGSimulator()`, `mod.HEAPF32`, …). No `ccall` /
`cwrap` is involved.

## Manifest

```json
{
  "structs":   { "Vec3": [["x", "f32"], ["y", "f32"], ["z", "f32"]] },
  "functions": [{ "name": "axialBField", "ret": "f32", "args": [["z", "f32"], …] }],
  "classes": {
    "SEGSimulator": {
      "prefix": "seg_", "scratch": "getScratchPtr",
      "methods": [{ "name": "step", "ret": "void", "args": [["dt", "f32"], ["loadTorque", "f32"]] }],
      "static":  [{ "name": "version", "ret": "cstr" }]
    }
  }
}
```

| Type | C | JS | Notes |
|---|---|---|---|
| `f32` `f64` `i32` | `float` `double` `int` | `number` | |
| `u32` `ptr` | `uint32_t` `uintptr_t` | `number` | read back `>>> 0` |
| `bool` | `int` (0/1) | `boolean` | |
| `cstr` | `const char*` | `string` | NUL-terminated UTF-8, returns only |
| struct name | `uintptr_t` | the struct | returns only: copied into one static 16-float block whose address comes back; the wrapper reads it before the next call |
| `Vec3` arg | three `float` | `{x, y, z}` | |
| `f32[]` arg | `const float*, int` | `ArrayLike<number>` | methods only: the wrapper stages it in the class's `scratch` |

Classes: `SEGSimulator`, …, and `CircuitSim` (#256, ADR-0018), the Circuit
Lab's MNA solver:

- `load(packed: f32[])`, the netlist in [`CIRCUIT.md`](CIRCUIT.md) format,
  staged through its scratch;
- `step(h)`, `setParam(elem, index, value)` / `getParam`, `reset()`;
- reads: node voltages, element current / voltage / power, stored energy and
  `stat(which)`;
- `readoutPtr()` / `readoutCount()`: one f64 block (header, node voltages,
  per-element window integrals), read zero-copy as a `Float64Array` over the
  module's heap (`src/circuit/readout.ts`, re-viewed when the heap grows);
- `errorText()`: why a load or step failed.

The hardware twin (#257, ADR-0019) adds two classes, both double-precision
inside and both read zero-copy through C++-owned `f64` blocks:

- `TwinEstimator` (`twin_*`), the EKF: `setParam` / `setProcessNoise` /
  `setSensorSigma` / `setInitial`, `reset()`, `predict(dt, v)`,
  `setMeasurement(c, z)` + `update()` (returns the NIS), `readoutPtr()` /
  `readoutCount()` (estimate, P, innovations, χ² window — layout in
  `cpp/src/twin/twin.h` and `src/twin/readout.ts`, checked by its count), and
  `save()` / `load()` over `snapshotPtr()` / `snapshotCount()` (the snapshot
  `twin` block).
- `TwinSysId` (`sysid_*`), the calibration: `dataPtr(n)` takes the run as
  n × [t, v, z…] doubles, `load(n)`, then `start()` and `iterate()` until it
  reports done (one LM iteration per call, so the offline worker can post
  progress), and the results: θ, covariance, x₀, R² per channel, condition,
  residual autocorrelation and warning bits.

`npm run test:unit` → `wasm-abi.test.mjs` exercises both through the shipped
binary; `test:twin` runs them end to end.

Two free functions, `circuit_kind_name(k)` and `circuit_format_version()`,
let `scripts/tests/circuit.test.mjs` hold `src/circuit/kinds.ts` to the
binary.

An arg may carry a third element, its TS default (`["remanenceT", "f32", 0]`).
A function may set `"cpp"` to an expression instead of a call
(`"SIM_CORE_SOURCE_HASH"`). Exports are named `sc_<fn>`, and
`<prefix><method>` plus `<prefix>new` / `<prefix>delete` per class.

## What fails where

| Break | Caught by |
|---|---|
| `sim_core.h` signature no longer matches the manifest | `make native`: the generated shim compiles natively too (`EMSCRIPTEN_KEEPALIVE` is empty there), under `-Werror` |
| Manifest edited, generated files not regenerated | `npm run check:wasm-abi` (in `validate`) |
| Committed binary older than the manifest | `test:wasm-abi`: the binary's export table must equal `SIM_CORE_ABI_EXPORTS`, both ways |
| A new libc dependency adds an import | `test:wasm-abi`: imports must be a subset of `SIM_CORE_IMPORTS` in `instantiate.ts` |
| An export that cannot be called | `test:wasm-abi`: each export is called once with a call spec; a new export without a spec fails |

So an ABI break fails at codegen or compile time. It cannot reach the frame
loop as a `TypeError`.

## Imports

| Import | Why | Loader |
|---|---|---|
| `env.emscripten_notify_memory_growth` | the heap grew | no-op: the wrappers rebuild their `Float32Array` views lazily |
| `wasi_snapshot_preview1.clock_time_get` | `std::time()` seeds the particle RNG | writes `Date.now()` in ns |

## Sizes

| | Embind (before) | C ABI (after) |
|---|---|---|
| JS glue / loader chunk | `sim_core.js` 22,582 B raw, 9,157 B gzip | `instantiate-*.js` 10,084 B raw, **2,598 B gzip (−72 %)** |
| Exports | 118 bound functions | 142 (adds the FDTD grid and integrator stats); 166 with the Circuit Lab's `CircuitSim` (#256); 220 with the twin's `TwinEstimator` / `TwinSysId` (#257) |
| `.wasm`, same sources | 83,332 B | 68,135 B (Embind's class registry gone) |
| `.wasm` today | | 163,244 B with the twin's EKF + sysid (#257); 122,380 B with the MNA solver (#256; was 74,145 B — [`cpp/bench-baseline.json`](../cpp/bench-baseline.json)) |

With no Emscripten JS left, there is no `MODULARIZE`, `EXPORTED_RUNTIME_METHODS`,
`DYNAMIC_EXECUTION`, `--closure` or `SINGLE_FILE` to configure. The module has
no `eval` / `new Function` path, so a strict CSP holds.

## Using it in Node

```js
import { loadSimCoreFromDisk } from '../lib/sim-core-shim.mjs';
const mod = await loadSimCoreFromDisk('src/wasm/sim-core');   // SimCoreModule
```

Harnesses that bundle the app's own loader pass `plugins: [simCoreShim(dir)]`.
The shim redirects `index.ts`'s `import('./sim-core/instantiate')` to read the
`.wasm` from disk, and production code has no override seam.

# sim_core WASM artefacts

`sim_core.wasm` is built by `make -C cpp wasm` (`npm run wasm:build`) with the
emsdk pinned in `config/toolchain.json`. CI (`.github/workflows/build-wasm.yml`)
rebuilds and commits it on `main` whenever anything compiled into the binary
changes. It is a standalone reactor module — **there is no Emscripten JS glue**
(#254 §3).

| File | What | Edit? |
|------|------|-------|
| `sim_core.wasm` | the binary | never by hand; never from CMake (a compile database only — see `cpp/README.md`) |
| `abi.generated.ts` | `SimCoreExports` (typed `instance.exports`) + `bindSimCore()` → `SimCoreModule` | generated from `cpp/abi.json` by `npm run codegen:wasm-abi` |
| `instantiate.ts` | fetch / instantiate, the module's two imports, `_initialize` | by hand — `test:wasm-abi` fails if the binary imports anything it does not supply |

`src/wasm/index.ts` references the `.wasm` with `new URL(…, import.meta.url)`
(Vite emits it under a content-hashed name) and lazy-`import()`s
`instantiate.ts`, so the page and every module worker (`plant-worker`,
`wasm-offline-worker`, `experiment-worker`) load it the same way — no
`<script>`, `importScripts` or `new Function`.

`sim_core_source_hash()` in the binary is compared with the site build's
`__SIM_CORE_SOURCE_HASH__` (`scripts/sim-core-source-hash.mjs`); a mismatch
means this binary predates its sources, and the WASM badge says so.

The manifest, codegen and conventions: [`docs/WASM_ABI.md`](../../../docs/WASM_ABI.md).

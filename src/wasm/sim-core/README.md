# sim_core WASM artefacts

`sim_core.js` (an ES module: `export default SimCore`) and `sim_core.wasm` are
built by `make -C cpp wasm` (`npm run wasm:build`) with the emsdk pinned in
`cpp/emsdk-version`. CI (`.github/workflows/build-wasm.yml`) rebuilds and
commits them on `main` whenever anything compiled into the binary changes.

`src/wasm/index.ts` imports both: Vite bundles the glue into a hashed chunk and
emits the `.wasm` under a content-hashed name, so a rebuilt plant busts the
HTTP cache. Workers (`plant-worker`, `wasm-offline-worker`, `experiment-worker`)
go through the same loader — there is no `<script>`, `importScripts` or
`new Function` path.

`sim_core.d.ts` types the default export. `sim_core_source_hash()` in the
binary is compared with the site build's `__SIM_CORE_SOURCE_HASH__`
(`scripts/sim-core-source-hash.mjs`); a mismatch means this binary predates its
sources, and the WASM badge says so.

Do not edit these files by hand, and do not build them with CMake (that path is
a compile database only — see `cpp/README.md`).

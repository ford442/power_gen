# ADR-0008: Device identity catalog (shaderMode vs wasmMode)

- **Status:** Accepted
- **Date:** 2026-08

## Context

Three sources independently numbered apparatuses: plugin `modeIndex` (WGSL
uniforms), C++ `enum SimMode`, and the WASM bridge `MODE_MAP`. The last six
“core” devices happen to agree; later plugins diverge (`homopolar` shader 8 vs
wasm 7; `pulse-coil` shader 7 with no plant). Mapping by device **id** kept
production working, but `setMode(getDeviceModeIndex(id))` would step the wrong
plant. Physics constants already use JSON → codegen.

## Decision

- Author **`physics/devices.json`** as the only list of live apparatuses.
- Keep two namespaces: **`shaderMode`** (never reuse a retired slot) and
  **`wasmMode`** (`SimMode` or `null` for JS-only). Do not silent-renumber
  existing shader slots (homopolar stays 8).
- Codegen emits TS, `enum SimMode`, WGSL `MODE_*` constants, and
  `docs/MODE_MATRIX.md`.
- The JS WASM bridge **`setMode(deviceId: string)`** looks up `wasmMode`; it
  does not accept a shader index. Reserved `wasmMode` values are listed in JSON
  without inventing plants.

## Consequences

- **Positive:** Adding a device is catalog + plugin + plant (if any). CI
  (`check:catalog`) catches duplicates, plugin/catalog skew, and missing WGSL
  named constants.
- **Negative:** Two numbers per device must be explained in docs; they will
  never be “cleaned up” by remapping shaders.
- **Neutral:** Energy-network nameplates remain wasm-ordered in
  `physics/constants.json`.

## Related

- ADR-0002 (WASM plant), `docs/MODE_MATRIX.md`, `docs/PHYSICS_CONSTANTS.md`

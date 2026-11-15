// =============================================================
// types.ts  –  TypeScript types for the sim_core WASM module
// =============================================================
//
// Generated, not hand-written (#254 §3): cpp/abi.json is the manifest and
// scripts/codegen-wasm-abi.mjs emits sim-core/abi.generated.ts (these types +
// the wrappers) and cpp/src/sim_core_abi.cpp (the extern "C" shim). Nothing
// crosses the boundary but scalars: array input is staged in a C++-owned
// scratch through HEAPF32 (get*ScratchPtr → *FromScratch), struct results come
// back through one static float block. `npm run test:wasm-abi` calls every
// export on the shipped .wasm and diffs its export table against the manifest.
// =============================================================

export type {
  ChoresReduceResult,
  ChoresReduceResult as ChoresReduceRaw,
  EnergyNetworkDevicePower,
  EnergyNetworkSummary,
  SEGSimulatorConstructor,
  SEGSimulatorInstance,
  SimCoreExports,
  SimCoreModule,
  SimParticle,
  Vec3
} from './sim-core/abi.generated';

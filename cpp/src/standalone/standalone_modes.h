// =============================================================
// standalone_modes.h  –  entry points for the native `--mode <name>` runs
//
// Each run_* returns 0 on success and non-zero on failure (the process exit
// code). Native only: every definition sits inside `#ifdef SIM_CORE_STANDALONE`
// and the TUs are built for the native target only (Makefile / CMake).
// main() and the CSV export live in sim_core_standalone.cpp.
// =============================================================
#pragma once

// standalone_plant_smokes.cpp — one smoke per plant
int run_peltier_smoke();
int run_mhd_smoke();
int run_hartmann();
int run_maglev_smoke();
int run_homopolar_smoke();
int run_transformer_smoke();
int run_vdg_smoke();
int run_hall_smoke();
int run_lorentz_smoke();
int run_jumping_ring_smoke();

// standalone_system_smokes.cpp — cross-plant / catalog checks
int run_chores_smoke();
int run_energy_network_smoke();
int run_catalog_smoke();
int run_fdtd_smoke();

// standalone_golden.cpp — GOLDEN_CASES is the SoT for `npm run test:golden`
int run_golden();

// standalone_bench.cpp
int run_bench_smoke();

// standalone_integrators.cpp — shared integrators vs the reference they replaced
int run_integrators();

// standalone_circuit.cpp — Circuit Lab MNA goldens (#256); -json dumps them for the WASM parity test
int run_circuit();
int run_circuit_json();

// standalone_snapshots.cpp — plantSave/plantLoad round trip is bit-exact (#224 §2)
int run_snapshots();

// standalone_twin.cpp — hardware twin (#257): AD vs central differences, EKF / sysid on a ground-truth rig
int run_ad();
int run_twin();

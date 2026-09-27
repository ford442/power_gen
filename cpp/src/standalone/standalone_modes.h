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

// standalone_golden.cpp — GOLDEN_CASES is the SoT for `npm run test:golden`
int run_golden();

// standalone_bench.cpp
int run_bench_smoke();

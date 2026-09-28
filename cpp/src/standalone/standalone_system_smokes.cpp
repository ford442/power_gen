// =============================================================
// standalone_system_smokes.cpp  –  cross-plant smokes (--mode chores | energy-network | catalog)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"
#include "../../generated/lab-coupling.h"

#include <cstdio>
#include <cstring>

int run_chores_smoke() {
    const float data[] = { 1.f, -2.f, 3.f, 0.f, 4.f };
    float out[5] = {};
    chores_reduce_f32(data, 5, out);
    printf("chores reduce sum=%.1f min=%.1f max=%.1f sumSq=%.1f n=%.0f\n",
           out[0], out[1], out[2], out[3], out[4]);
    if (std::fabs(out[0] - 6.f) > 1e-5f || std::fabs(out[1] + 2.f) > 1e-5f
        || std::fabs(out[2] - 4.f) > 1e-5f || std::fabs(out[3] - 30.f) > 1e-5f
        || std::fabs(out[4] - 5.f) > 1e-5f) {
        printf("FAIL: chores reduce golden mismatch\n");
        return 1;
    }
    float mapped[5] = {};
    chores_map_scale_f32(data, mapped, 5, 0.8f, 0.2f);
    if (std::fabs(mapped[0] - 1.0f) > 1e-5f || std::fabs(mapped[1] + 1.4f) > 1e-5f) {
        printf("FAIL: chores map golden mismatch (got %.3f %.3f)\n", mapped[0], mapped[1]);
        return 1;
    }
    printf("chores reduce/map goldens OK\n");
    return 0;
}

static int catalog_wasm_mode(const char* id) {
    for (int i = 0; i < DEVICE_CATALOG_COUNT; ++i) {
        if (std::strcmp(DEVICE_CATALOG[i].id, id) == 0) return DEVICE_CATALOG[i].wasmMode;
    }
    return -1;
}

int run_energy_network_smoke() {
    SEGSimulator sim;
    // The same graph the TS EnergyNetwork draws (physics/coupling.json →
    // generated/lab-coupling.h). Edges touching a JS-only device (no wasmMode,
    // e.g. halbach-viz) are dropped exactly as src/wasm/sim.ts setNetworkEdges
    // drops them, so the expected count is derived rather than hand-kept.
    std::vector<float> edges;
    int expectedEdges = 0;
    for (int i = 0; i < power_gen::ENERGY_PIPE_CATALOG_COUNT; ++i) {
        const power_gen::EnergyPipeCatalogRow& row = power_gen::ENERGY_PIPE_CATALOG[i];
        const int from = catalog_wasm_mode(row.from);
        const int to = catalog_wasm_mode(row.to);
        if (from < 0 || to < 0) {
            printf("energy edge %s -> %s: JS-only endpoint, not on the C++ bus\n", row.from, row.to);
            continue;
        }
        // from, to, maxW, eff, latency — the flat layout setNetworkEdges expects.
        edges.insert(edges.end(), { static_cast<float>(from), static_cast<float>(to), row.maxWatts, 1.f, 0.f });
        ++expectedEdges;
    }
    sim.setNetworkEdges(edges);

    const float dt = 1.f / 60.f;
    const int steps = static_cast<int>(1.2f / dt); // ≥1 s
    std::vector<float> energyLevels(ENERGY_NETWORK_MODE_COUNT, 0.f);
    std::vector<int> enabled(ENERGY_NETWORK_MODE_COUNT, 1);

    for (int i = 0; i < steps; ++i) {
        // Advance a few mode plants and feed bus with synthetic levels
        sim.setMode(SIM_MODE_SEG);
        sim.setDrive(0.7f);
        sim.step(dt, 0.01f);
        energyLevels[SIM_MODE_SEG] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_HERON);
        sim.setDrive(0.8f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_HERON] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_KELVIN);
        sim.setDrive(0.9f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_KELVIN] = sim.getEnergyLevel();

        const float segPowerW = sim.estimatePower(0.01f);
        sim.updateEnergyNetwork(true, segPowerW, 88.f, energyLevels, enabled);

        const EnergyNetworkSummary sum = sim.getNetworkSummary();
        if (!std::isfinite(sum.labBudgetW) || !std::isfinite(sum.totalAllocatedW)
            || !std::isfinite(sum.residualW)) {
            printf("FAIL: energy bus NaN at step %d\n", i);
            return 1;
        }
        if (sum.labBudgetW < 0.f || sum.totalAllocatedW < 0.f) {
            printf("FAIL: negative bus watts at step %d\n", i);
            return 1;
        }
    }

    const EnergyNetworkSummary finalSum = sim.getNetworkSummary();
    printf("Energy bus: budget=%.1f W  allocated=%.1f W  residual=%.1f W  edges=%d\n",
           finalSum.labBudgetW, finalSum.totalAllocatedW, finalSum.residualW,
           sim.getNetworkEdgeCount());
    if (sim.getNetworkEdgeCount() != expectedEdges) {
        printf("FAIL: expected %d network edges, bus holds %d\n", expectedEdges, sim.getNetworkEdgeCount());
        return 1;
    }
    if (finalSum.totalAllocatedW <= 0.f) {
        printf("FAIL: no power allocated on coupled bus\n");
        return 1;
    }
    printf("Energy network smoke OK (%.1f s, %d steps)\n", steps * dt, steps);
    return 0;
}

int run_catalog_smoke() {
    bool seen[SIM_MODE_COUNT]{};
    for (int i = 0; i < DEVICE_CATALOG_COUNT; i++) {
        const DeviceCatalogRow& r = DEVICE_CATALOG[i];
        if (r.wasmMode < 0) {
            printf("%s -> wasmMode none (shaderMode %d)\n", r.id, r.shaderMode);
            continue;
        }
        printf("%s -> wasmMode %d (shaderMode %d)\n", r.id, r.wasmMode, r.shaderMode);
        if (r.wasmMode >= SIM_MODE_COUNT) {
            fprintf(stderr, "FAIL: wasmMode out of range for %s\n", r.id);
            return 1;
        }
        if (seen[r.wasmMode]) {
            fprintf(stderr, "FAIL: duplicate wasmMode %d\n", r.wasmMode);
            return 1;
        }
        seen[r.wasmMode] = true;
    }
    for (int i = 0; i < SIM_MODE_COUNT; i++) {
        if (!seen[i]) {
            fprintf(stderr, "FAIL: wasmMode hole at %d\n", i);
            return 1;
        }
    }
    printf("catalog OK (%d devices, %d wasm plants, reserved", DEVICE_CATALOG_COUNT, SIM_MODE_COUNT);
    for (int i = 0; i < RESERVED_WASM_MODE_COUNT; i++) {
        printf(" %d", RESERVED_WASM_MODES[i]);
    }
    printf(")\n");
    return 0;
}

#endif // SIM_CORE_STANDALONE

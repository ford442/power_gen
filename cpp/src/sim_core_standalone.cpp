// =============================================================
// sim_core_standalone.cpp  –  native smoke-test driver + CSV export
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "telemetry_export.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static float clamp01f(float v) {
    return v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
}

int export_seg_csv(
    const char* path, float durationSec, float sampleHz,
    float drive, float loadTorque, float fieldStrength, float loadOhm)
{
    SEGSimulator sim;
    sim.setMode(SIM_MODE_SEG);
    sim.setDrive(drive);
    sim.seedParticles(1000);

    FILE* f = std::fopen(path, "w");
    if (!f) return 1;

    std::fprintf(f, "%s\n", TELEMETRY_CSV_HEADER);

    const float physicsDt = 1.f / 60.f;
    const float sampleDt = 1.f / sampleHz;
    float simTime = 0.f;
    float accum = 0.f;
    int frameId = 0;
    int steps = 0;
    const int maxSteps = static_cast<int>(durationSec * 60.f) + 2;

    while (simTime < durationSec && steps < maxSteps) {
        sim.step(physicsDt, loadTorque);
        sim.stepParticles(physicsDt);
        simTime += physicsDt;
        accum += physicsDt;
        steps++;

        while (accum >= sampleDt && simTime <= durationSec + 1e-3f) {
            accum -= sampleDt;
            frameId++;
            const float tSample = simTime - accum;
            const float omega = sim.getOmega();
            const float segOmega = clamp01f(omega / 50.f);
            float rotationSpeed = segOmega * 100.f;
            if (rotationSpeed > 120.f) rotationSpeed = 120.f;
            const float corona = clamp01f((segOmega - 0.6f) / 0.4f);
            const float rpmInner = rotationSpeed * 30.f;
            const float voltage = rotationSpeed * fieldStrength * 2.5f;
            const float current = loadOhm > 0.f ? voltage / loadOhm : 0.f;
            const float power = sim.estimatePower(loadTorque);
            const float fieldSim = fieldStrength * (1.f + rotationSpeed / 200.f) * TELEMETRY_B_SURFACE_T;
            const float energyD = sim.magneticEnergyDensity();
            const float temp = 25.f + rotationSpeed * 0.3f + corona * 12.f;
            const float eff = drive > 0.f ? 85.f + (rotationSpeed / 100.f) * 10.f : 0.f;

            std::fprintf(f,
                "%.6f,%d,seg,seg,operational,%.2f,%.6f,%.6f,"
                "%.4f,%.6f,%.4f,%.6f,%.6e,"
                "%.4f,%d,%.2f,%.2f,0,%.1f\n",
                tSample, frameId,
                rpmInner, segOmega, corona,
                voltage, current, power, fieldSim, energyD,
                drive, static_cast<int>(fieldStrength * 100.f), temp, eff, loadOhm);
        }
    }

    std::fclose(f);
    return 0;
}

static int run_peltier_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_PELTIER);
    sim.setDrive(1.f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 3600; ++i) { // 60 s to let the stack heat up
        sim.step(dt, 0.f);
        if ((i & 7) == 0) sim.stepParticles(dt);
    }
    printf("Peltier Th=%.1f K  Tc=%.1f K  dT=%.1f K  V=%.3f V  I=%.3f A  P=%.3f W  eff=%.3f\n",
           sim.getPeltierHotK(), sim.getPeltierColdK(), sim.getPeltierDeltaT(),
           sim.getPeltierVoltage(), sim.getPeltierCurrent(),
           sim.getPeltierPowerW(), sim.getPeltierCOP());
    if (sim.getPeltierDeltaT() <= 1.f || sim.getPeltierPowerW() <= 0.f) {
        printf("FAIL: Peltier stack did not develop dT / power\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Peltier energy level out of range\n");
        return 1;
    }
    printf("Peltier smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_mhd_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MHD);
    sim.setDrive(0.9f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) {
        sim.step(dt, 0.f);
        sim.stepParticles(dt);
    }
    printf("MHD u=%.3f m/s  B=%.3f T  Ha=%.0f  V=%.4f V  I=%.3f A  P=%.4f W\n",
           sim.getMhdFlowU(), sim.getMhdBFieldT(), sim.getMhdHartmann(),
           sim.getMhdVoltage(), sim.getMhdCurrent(), sim.getMhdPowerW());
    if (sim.getMhdFlowU() <= 0.f || sim.getMhdVoltage() <= 0.f) {
        printf("FAIL: MHD channel did not develop flow / voltage\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: MHD energy level out of range\n");
        return 1;
    }
    printf("MHD smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_maglev_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MAGLEV);
    sim.setDrive(0.85f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f);
    printf("Maglev gap=%.4f m (%.2f mm)  B=%.3f T  lift=%.3f N  rpm=%.0f\n",
           sim.getMaglevGap(), sim.getMaglevGapMm(),
           sim.getMaglevFieldT(), sim.getMaglevLiftN(), sim.getMaglevRpm());
    if (sim.getMaglevGap() <= 0.f || sim.getMaglevFieldT() <= 0.f
        || !std::isfinite(sim.getMaglevGap()) || !std::isfinite(sim.getMaglevRpm())) {
        printf("FAIL: Maglev gap / field did not develop\n");
        return 1;
    }
    if (sim.getMaglevRpm() <= 0.f) {
        printf("FAIL: Maglev RPM stayed zero under drive\n");
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Maglev energy level out of range\n");
        return 1;
    }
    printf("Maglev smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_homopolar_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_HOMOPOLAR);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 900; ++i) sim.step(dt, 0.f);
    printf("Homopolar rpm=%.1f  EMF=%.4f V  I=%.3f A  B=%.3f T\n",
           sim.getHomopolarRpm(), sim.getHomopolarEmfV(),
           sim.getHomopolarCurrentA(), sim.getHomopolarFieldT());
    if (sim.getHomopolarRpm() <= 0.f || sim.getHomopolarEmfV() <= 0.f) {
        printf("FAIL: Homopolar disc did not develop RPM / EMF\n");
        return 1;
    }
    if (sim.getHomopolarCurrentA() <= 0.f) {
        printf("FAIL: Homopolar current stayed zero\n");
        return 1;
    }
    printf("Homopolar smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_transformer_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_TRANSFORMER);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    const int steps = 60; // 1 s
    for (int i = 0; i < steps; ++i) {
        sim.step(dt, 0.f);
        const float i1 = sim.getTransformerI1();
        const float i2 = sim.getTransformerI2();
        const float v2 = sim.getTransformerV2();
        if (!std::isfinite(i1) || !std::isfinite(i2) || !std::isfinite(v2)) {
            printf("FAIL: transformer NaN at step %d (I1=%g I2=%g V2=%g)\n", i, i1, i2, v2);
            return 1;
        }
    }
    printf("Transformer I1=%.3f A  I2=%.3f A  V1=%.2f V  V2=%.2f V  k=%.2f  flux=%.3f\n",
           sim.getTransformerI1(), sim.getTransformerI2(),
           sim.getTransformerV1(), sim.getTransformerV2(),
           sim.getTransformerK(), sim.getTransformerFluxN());
    if (std::abs(sim.getTransformerI1()) < 1e-4f
        && std::abs(sim.getTransformerI2()) < 1e-4f
        && std::abs(sim.getTransformerV2()) < 1e-4f) {
        printf("FAIL: transformer plant did not develop I1/I2/V2 under drive\n");
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: transformer energy level out of range\n");
        return 1;
    }
    printf("Transformer smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_chores_smoke() {
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

static int run_energy_network_smoke() {
    SEGSimulator sim;
    // Mirror ENERGY_PIPE_EDGES (from, to, maxW, eff, latency)
    const float edges[] = {
        0, 1, 1500.f, 1.f, 0.f,
        1, 2,  800.f, 1.f, 0.f,
        2, 0,  600.f, 1.f, 0.f,
        2, 4,  400.f, 1.f, 0.f,
        4, 3,  500.f, 1.f, 0.f,
        0, 5, 1200.f, 1.f, 0.f,
        5, 4,  700.f, 1.f, 0.f,
        3, 6,  450.f, 1.f, 0.f,
        6, 0,  550.f, 1.f, 0.f,
    };
    sim.setNetworkEdges(std::vector<float>(edges, edges + sizeof(edges) / sizeof(edges[0])));

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
    if (sim.getNetworkEdgeCount() != 9) {
        printf("FAIL: expected 9 network edges\n");
        return 1;
    }
    if (finalSum.totalAllocatedW <= 0.f) {
        printf("FAIL: no power allocated on coupled bus\n");
        return 1;
    }
    printf("Energy network smoke OK (%.1f s, %d steps)\n", steps * dt, steps);
    return 0;
}

static int run_catalog_smoke() {
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

int main(int argc, char** argv) {
    // --mode <peltier|mhd|maglev|homopolar>: run a single-mode smoke test
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            if (std::strcmp(argv[i + 1], "peltier") == 0) return run_peltier_smoke();
            if (std::strcmp(argv[i + 1], "mhd") == 0)     return run_mhd_smoke();
            if (std::strcmp(argv[i + 1], "maglev") == 0)  return run_maglev_smoke();
            if (std::strcmp(argv[i + 1], "homopolar") == 0) return run_homopolar_smoke();
            if (std::strcmp(argv[i + 1], "transformer") == 0) return run_transformer_smoke();
            if (std::strcmp(argv[i + 1], "chores") == 0) return run_chores_smoke();
            if (std::strcmp(argv[i + 1], "energy-network") == 0) return run_energy_network_smoke();
            if (std::strcmp(argv[i + 1], "catalog") == 0) return run_catalog_smoke();
            std::fprintf(stderr, "Unknown --mode %s (expected peltier|mhd|maglev|homopolar|transformer|chores|energy-network|catalog)\n", argv[i + 1]);
            return 2;
        }
    }
    // --export-csv <seconds> [output.csv] [sample_hz]
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--export-csv") == 0 && i + 1 < argc) {
            const float duration = std::atof(argv[i + 1]);
            const char* out = (i + 2 < argc && argv[i + 2][0] != '-') ? argv[i + 2] : "build/seg_telemetry.csv";
            const float hz = (i + 3 < argc) ? std::atof(argv[i + 3]) : 10.f;
            const int rc = export_seg_csv(out, duration, hz, 0.5f, 0.01f, 0.5f, 100.f);
            if (rc != 0) {
                std::fprintf(stderr, "Failed to write %s\n", out);
                return rc;
            }
            std::printf("Exported %g s SEG telemetry → %s @ %.1f Hz\n", duration, out, hz);
            return 0;
        }
    }

    printf("sim_core version: %s\n", sim_core_version());

    SEGSimulator sim;
    printf("Rollers: %d\n", sim.numRollers());

    // ── SEG path ──
    sim.setMode(SIM_MODE_SEG);
    sim.seedParticles(1000);
    float dt = 1.f / 60.f;
    for (int i = 0; i < 100; ++i) {
        sim.step(dt, 0.01f);
        sim.stepParticles(dt);
    }
    printf("SEG Omega after 100 steps: %.4f rad/s (%.1f RPM)\n",
           sim.getOmega(), sim.getRPM());
    printf("Magnetic energy density: %.4e J/m^3\n", sim.magneticEnergyDensity());
    printf("Estimated power (load 0.01 Nm): %.4f W\n", sim.estimatePower(0.01f));

    // ── Heron path ──
    sim.setMode(SIM_MODE_HERON);
    sim.setDrive(0.8f);
    for (int i = 0; i < 200; ++i) sim.step(dt, 0.f);
    printf("Heron head=%.3f m  vExit=%.3f m/s  Q=%.2f L/min  P=%.2f kPa\n",
           sim.getHeronHead(), sim.getHeronVExit(),
           sim.getHeronFlowLmin(), sim.getHeronPressureKPa());
    if (sim.getHeronHead() <= 0.f && sim.getHeronVExit() <= 0.f) {
        printf("FAIL: Heron state did not advance\n");
        return 1;
    }

    // ── Kelvin path ──
    sim.setMode(SIM_MODE_KELVIN);
    sim.setDrive(1.f);
    for (int i = 0; i < 400; ++i) sim.step(dt, 0.f);
    printf("Kelvin V=%.1f V  Vn=%.3f  E=%.2f  sparkT=%.3f\n",
           sim.getKelvinVoltage(), sim.getKelvinVoltageN(),
           sim.getKelvinE(), sim.getKelvinSparkTimer());
    if (sim.getKelvinVoltage() <= 0.f && sim.getKelvinVoltageN() <= 0.f) {
        printf("FAIL: Kelvin state did not advance\n");
        return 1;
    }

    // ── Solar path ──
    sim.setMode(SIM_MODE_SOLAR);
    sim.setDrive(1.f);
    float bat0 = sim.getSolarBattery();
    for (int i = 0; i < 300; ++i) sim.step(dt, 0.f);
    printf("Solar battery SOC: %.3f -> %.3f\n", bat0, sim.getSolarBattery());
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Solar energy level out of range\n");
        return 1;
    }

    // ── Peltier + MHD + Quanta plugin paths ──
    if (run_peltier_smoke() != 0) return 1;
    if (run_mhd_smoke() != 0) return 1;
    if (run_maglev_smoke() != 0) return 1;
    if (run_homopolar_smoke() != 0) return 1;
    if (run_transformer_smoke() != 0) return 1;
    if (run_chores_smoke() != 0) return 1;
    if (run_energy_network_smoke() != 0) return 1;

    // Zero-copy packing smoke
    sim.setMode(SIM_MODE_SEG);
    sim.packRollerState();
    printf("Zero-copy: particlePtr=%zu floats=%d  rollerPtr=%zu floats=%d\n",
           (size_t)sim.getParticleBufferPtr(), sim.getParticleFloatCount(),
           (size_t)sim.getRollerStatePtr(), sim.getRollerStateFloatCount());
    if (sim.getRollerStateFloatCount() != 66 * 4) {
        printf("FAIL: unexpected roller export size\n");
        return 1;
    }
    if (sim.getParticleFloatCount() != 1000 * 8) {
        printf("FAIL: unexpected particle export size (got %d, expected %d)\n",
               sim.getParticleFloatCount(), 1000 * 8);
        return 1;
    }

    printf("All mode smoke tests OK\n");
    return 0;
}

#endif // SIM_CORE_STANDALONE

// =============================================================
// sim_core_standalone.cpp  –  native smoke-test driver: main() + CSV export
//   --mode families live in standalone/ (plant smokes, system smokes, golden, bench)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"
#include "telemetry_export.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
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

    // Full v2 header: SEG base columns + every catalog device column.
    std::fprintf(f, "%s,%s\n", TELEMETRY_CSV_BASE_HEADER, TELEMETRY_CSV_DEVICE_COLUMNS);

    // This driver runs the SEG plant only; other devices export as zeros.
    std::string deviceZeros;
    deviceZeros.reserve(TELEMETRY_CSV_DEVICE_COLUMN_COUNT * 2);
    for (int i = 0; i < TELEMETRY_CSV_DEVICE_COLUMN_COUNT; ++i) {
        deviceZeros += ",0";
    }

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
                "%.4f,%d,%.2f,%.2f,0,%.1f,%s%s\n",
                tSample, frameId,
                rpmInner, segOmega, corona,
                voltage, current, power, fieldSim, energyD,
                drive, static_cast<int>(fieldStrength * 100.f), temp, eff, loadOhm,
                TELEMETRY_CSV_SEG_ONLY_TAIL, deviceZeros.c_str());
        }
    }

    std::fclose(f);
    return 0;
}

int main(int argc, char** argv) {
    // --mode <peltier|mhd|…|catalog|bench|golden>: run one smoke test / report
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            if (std::strcmp(argv[i + 1], "peltier") == 0) return run_peltier_smoke();
            if (std::strcmp(argv[i + 1], "mhd") == 0)     return run_mhd_smoke();
            if (std::strcmp(argv[i + 1], "maglev") == 0)  return run_maglev_smoke();
            if (std::strcmp(argv[i + 1], "homopolar") == 0) return run_homopolar_smoke();
            if (std::strcmp(argv[i + 1], "transformer") == 0) return run_transformer_smoke();
            if (std::strcmp(argv[i + 1], "vdg") == 0) return run_vdg_smoke();
            if (std::strcmp(argv[i + 1], "hall") == 0) return run_hall_smoke();
            if (std::strcmp(argv[i + 1], "lorentz-sled") == 0) return run_lorentz_smoke();
            if (std::strcmp(argv[i + 1], "jumping-ring") == 0) return run_jumping_ring_smoke();
            if (std::strcmp(argv[i + 1], "chores") == 0) return run_chores_smoke();
            if (std::strcmp(argv[i + 1], "energy-network") == 0) return run_energy_network_smoke();
            if (std::strcmp(argv[i + 1], "catalog") == 0) return run_catalog_smoke();
            if (std::strcmp(argv[i + 1], "bench") == 0) return run_bench_smoke();
            if (std::strcmp(argv[i + 1], "golden") == 0) return run_golden();
            std::fprintf(stderr, "Unknown --mode %s (expected peltier|mhd|maglev|homopolar|transformer|vdg|hall|lorentz-sled|jumping-ring|chores|energy-network|catalog|bench|golden)\n", argv[i + 1]);
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
    if (run_vdg_smoke() != 0) return 1;
    if (run_hall_smoke() != 0) return 1;
    if (run_lorentz_smoke() != 0) return 1;
    if (run_jumping_ring_smoke() != 0) return 1;
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

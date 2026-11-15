// =============================================================
// standalone_bench.cpp  –  --mode bench (SEG RK4, particles, shared integrators)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <chrono>
#include <cstdio>
#include <vector>

// --mode bench: report SEG RK4 roller step throughput (steps/s) and
// particle-replay throughput, as a plain "key=value" line CI can grep to
// track regressions from compile-flag changes (SIMD, LTO, etc.) over time.
int run_bench_smoke() {
    SEGSimulator sim;
    const float dt = 1.f / 60.f;
    const int warmup = 2000;
    const int steps = 100000;
    for (int i = 0; i < warmup; ++i) sim.step(dt, 0.01f);

    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < steps; ++i) sim.step(dt, 0.01f);
    auto t1 = std::chrono::steady_clock::now();
    const double stepSec = std::chrono::duration<double>(t1 - t0).count();
    const double stepsPerSec = steps / stepSec;

    sim.seedParticles(2000);
    const int particleWarmup = 500;
    const int particleSteps = 5000;
    for (int i = 0; i < particleWarmup; ++i) sim.stepParticles(dt);

    auto t2 = std::chrono::steady_clock::now();
    for (int i = 0; i < particleSteps; ++i) sim.stepParticles(dt);
    auto t3 = std::chrono::steady_clock::now();
    const double particleSec = std::chrono::duration<double>(t3 - t2).count();
    const double particleStepsPerSec = particleSteps / particleSec;

    printf("bench_seg_steps_per_sec=%.0f\n", stepsPerSec);
    printf("bench_particle_steps_per_sec=%.0f\n", particleStepsPerSec);

    // Shared integrators (core/integrate.h): the jumping ring on each method,
    // simulated seconds per wall second and RHS calls per simulated second.
    // --mode integrators has the accuracy side of the same comparison.
    const int ringFrames = 400;
    const float ringDt = 1.f / 90.f;
    double rk4Rhs = 0;
    for (int m : { 1, 2, 3 }) {
        SEGSimulator ring;
        ring.setMode(SIM_MODE_JUMPING_RING);
        ring.setDrive(0.85f);
        ring.setIntegrator(m);
        ring.resetOdeStats();
        auto r0 = std::chrono::steady_clock::now();
        for (int i = 0; i < ringFrames; ++i) ring.step(ringDt, 0.f);
        auto r1 = std::chrono::steady_clock::now();
        const double simSec = ringFrames * static_cast<double>(ringDt);
        const double wall = std::chrono::duration<double>(r1 - r0).count();
        const double rhsPerSimSec = ring.getOdeRhsEvals() / simSec;
        if (m == 1) rk4Rhs = rhsPerSimSec;
        const char* name = sim_core::integrator_name(static_cast<sim_core::Integrator>(m));
        printf("bench_ring_%s_sim_s_per_wall_s=%.1f\n", name, simSec / wall);
        printf("bench_ring_%s_rhs_per_sim_s=%.0f\n", name, rhsPerSimSec);
        if (m != 1) printf("bench_ring_%s_rhs_ratio_vs_rk4=%.2f\n", name, rk4Rhs / rhsPerSimSec);
    }

    // FDTD TM_z kernel (#254 §5), the WebGPU slice's 256² grid with a material
    // map: cell updates (H + E) per second.
    {
        FdtdTmzGrid g;
        const int n = 256;
        g.init(n, 28, 0.5f, 0.12f, 1.6f);
        std::vector<float> mat(2 * n * n, 0.f);
        for (int i = 0; i < n * n; ++i) mat[2 * i] = (i % n) < n / 2 ? 1.f : 0.5f;
        g.setMaterials(mat.data(), static_cast<int>(mat.size()));
        const float src[4] = { 128.f, 128.f, 1.f, 1.f };
        g.setSources(src, 4);
        g.step(20);
        const int fdtdSteps = 400;
        auto f0 = std::chrono::steady_clock::now();
        g.step(fdtdSteps);
        auto f1 = std::chrono::steady_clock::now();
        const double cells = static_cast<double>(n) * n * fdtdSteps;
        printf("bench_fdtd_cell_updates_per_sec=%.0f\n", cells / std::chrono::duration<double>(f1 - f0).count());
    }
    return 0;
}

#endif // SIM_CORE_STANDALONE

// =============================================================
// standalone_bench.cpp  –  --mode bench (SEG RK4 + particle throughput)
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <chrono>
#include <cstdio>

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
    return 0;
}

#endif // SIM_CORE_STANDALONE

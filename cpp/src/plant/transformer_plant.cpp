// =============================================================
// transformer_plant.cpp  –  two-winding coupled-inductor ODE
// V1 = L1 dI1/dt + M dI2/dt + R1 I1
// V2 = L2 dI2/dt + M dI1/dt + R2 I2
// Secondary loaded: V2 = −R_load I2
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void SEGSimulator::setTransformerLeakage(bool enabled) {
    _transformer.leakage = enabled;
    _transformer.k = enabled ? _transformer.kLeakage : _transformer.kIdeal;
}

void SEGSimulator::_stepTransformer(float dt) {
    if (!(dt > 0.f) || !std::isfinite(dt)) return;

    TransformerState& t = _transformer;
    t.k = t.leakage ? t.kLeakage : t.kIdeal;
    const float L1 = t.l1H;
    const float L2 = t.l2H;
    const float M = t.k * std::sqrt(std::max(L1 * L2, 1e-12f));
    float D = L1 * L2 - M * M;
    if (D < 1e-8f) D = 1e-8f;

    const float omega = PhysicsConstants::TAU * t.fHz;
    const float drive = clampf(t.drive, 0.f, 1.f);
    // Leakage τ ≈ (1−k²) L2 / (R2+Rload) ~ 0.5 ms at k=0.97.
    // Browser first frames can deliver dt ≫ 1/60; clamp and adapt substeps.
    float remaining = dt;
    if (remaining > 0.05f) remaining = 0.05f;

    float i1 = t.i1;
    float i2 = t.i2;
    // Phase accumulates ~20k substeps per second of sim; in float it drifts
    // by ~1e-2 rad after a few seconds (and worse the longer the bench runs,
    // because the running value grows without bound). Accumulate in double
    // and wrap to one period below, so the stored float is always small and
    // the TS fallback — which has no choice but to use double — integrates
    // the same drive waveform.
    double phase = static_cast<double>(t.phase);
    constexpr float kHTarget = 5.0e-5f;
    constexpr int kSubMax = 800;

    const double omegaD = static_cast<double>(omega);
    const double vPeakDrive = static_cast<double>(t.vPeak) * static_cast<double>(drive);
    auto driveV = [&](double ph) { return static_cast<float>(vPeakDrive * std::sin(ph)); };

    auto deriv = [&](float i1s, float i2s, float v1s, float& di1, float& di2) {
        const float v2s = -t.rLoadOhm * i2s;
        const float rhs1 = v1s - t.r1Ohm * i1s;
        const float rhs2 = v2s - t.r2Ohm * i2s;
        di1 = (L2 * rhs1 - M * rhs2) / D;
        di2 = (L1 * rhs2 - M * rhs1) / D;
    };

    float v1 = driveV(phase);
    while (remaining > 1e-8f) {
        int nSub = static_cast<int>(std::ceil(remaining / kHTarget));
        if (nSub < 8) nSub = 8;
        if (nSub > kSubMax) nSub = kSubMax;
        const float chunk = remaining > kHTarget * static_cast<float>(kSubMax)
            ? kHTarget * static_cast<float>(kSubMax)
            : remaining;
        const float h = chunk / static_cast<float>(nSub);

        bool ok = true;
        const double omegaH = omegaD * static_cast<double>(h);
        for (int s = 0; s < nSub; ++s) {
            v1 = driveV(phase);

            float k1a, k1b, k2a, k2b, k3a, k3b, k4a, k4b;
            deriv(i1, i2, v1, k1a, k1b);
            const float v1m = driveV(phase + 0.5 * omegaH);
            deriv(i1 + 0.5f * h * k1a, i2 + 0.5f * h * k1b, v1m, k2a, k2b);
            deriv(i1 + 0.5f * h * k2a, i2 + 0.5f * h * k2b, v1m, k3a, k3b);
            const float v1e = driveV(phase + omegaH);
            deriv(i1 + h * k3a, i2 + h * k3b, v1e, k4a, k4b);

            const float n1 = i1 + (h / 6.f) * (k1a + 2.f * k2a + 2.f * k3a + k4a);
            const float n2 = i2 + (h / 6.f) * (k1b + 2.f * k2b + 2.f * k3b + k4b);
            if (!std::isfinite(n1) || !std::isfinite(n2)) {
                ok = false;
                break;
            }
            i1 = n1;
            i2 = n2;
            phase += omegaH;
        }
        if (!ok) break;
        remaining -= chunk;
    }

    // Wrap to one period: sin() is unchanged, and the stored float keeps
    // full precision however long the bench has been running.
    const double twoPi = 2.0 * static_cast<double>(PhysicsConstants::PI);
    phase = std::fmod(phase, twoPi);
    if (phase < 0.0) phase += twoPi;

    t.i1 = i1;
    t.i2 = i2;
    t.phase = static_cast<float>(phase);
    t.v1 = v1;
    t.v2 = -t.rLoadOhm * i2;

    const float lambda = L1 * i1 + M * i2;
    const float lambdaRef = t.vPeak / std::max(omega, 1.f);
    t.fluxN = clampf(std::abs(lambda) / lambdaRef, 0.f, 1.f);
}

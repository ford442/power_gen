// =============================================================
// thomson_plant.cpp – Thomson jumping ring: Lenz's law as motion.
//
// An AC primary on a laminated core and an aluminium ring treated as a
// shorted single-turn secondary that carries mass and gravity. The two
// circuits are coupled by a *height-dependent* mutual inductance:
//
//   k(h)  = k0 · exp(−h / lambda)
//   M(h)  = k(h) · sqrt(Lp · Lr)          dM/dh = −M(h) / lambda
//
//   Vp = Lp dIp/dt + M dIr/dt + (dM/dh)·v·Ir + Rp·Ip
//   0  = Lr dIr/dt + M dIp/dt + (dM/dh)·v·Ip + Rr·Ir     (ring is shorted)
//   m dv/dt = Ip·Ir·(dM/dh) − m·g − b·v                  (coenergy gradient)
//   dh/dt   = v
//
// The motional terms and the force come from the same dM/dh, so the model is
// energy-consistent: the work the field does on the ring is exactly the
// back-EMF the circuits see. Lenz is not bolted on — the ring current comes
// out opposing the primary, the product Ip·Ir is negative on average, dM/dh
// is negative, and the resulting force is *up*.
//
// Because M falls with height, the lift falls with height too, so the ring
// settles where the cycle-averaged force balances its weight rather than
// leaving the pole. `poleHeightM` is a rigid stop at the top, and h = 0 is
// the core shoulder the ring rests on.
//
// Educational classroom demo. Lumped circuit plus rigid body: no eddy-current
// FEM, no skin depth, no contact model, and **no thermal state at all** — this
// ring never heats, glows or melts, and this is not an induction-furnace or
// launcher model. Mirrors JUMPING_RING + stepJumpingRingPhysics in
// devices/quanta/jumping-ring.ts term for term.
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <cmath>

using namespace plant_common;
using JR = power_gen::ode::JumpingRing;

ThomsonPlant::ThomsonPlant(ThomsonState& st)
    : s(st),
      lpLr(st.lPrimaryH * st.lRingH),
      sqrtLpLr(std::sqrt(lpLr > 1e-24f ? lpLr : 1e-24f)),
      invLambda(1.f / st.lambdaM) {}

void ThomsonPlant::derivs(double t, std::span<const float> x, const ThomsonInput& u,
                          std::span<float> dxdt) const {
    // D = Lp·Lr − M² is ~1.5e-9 H² for a ring this small, so the transformer's
    // 1e-8 floor would swamp it. Guard only against an actual degenerate k.
    constexpr float kDMin = 1e-13f;
    const float ips = x[JR::primaryIA], irs = x[JR::ringCurrentA];
    const float vels = x[JR::velocityMps], hs = x[JR::heightM];
    const float vps = static_cast<float>(u.vPeakDrive * std::sin(u.phase0 + u.omega * t));
    const float Lp = s.lPrimaryH, Lr = s.lRingH;
    const float k = s.k0 * std::exp(-hs * invLambda);
    const float M = k * sqrtLpLr;
    const float dMdh = -M * invLambda;
    float D = lpLr - M * M;
    if (D < kDMin) D = kDMin;
    // Motional EMF: the coupling itself changes as the ring moves, so the
    // same dM/dh that produces the force also loads both circuits.
    const float motional = dMdh * vels;
    const float rhsP = vps - s.rPrimaryOhm * ips - motional * irs;
    const float rhsR = -s.rRingOhm * irs - motional * ips;
    dxdt[JR::primaryIA] = (Lr * rhsP - M * rhsR) / D;
    dxdt[JR::ringCurrentA] = (Lp * rhsR - M * rhsP) / D;
    const float f = ips * irs * dMdh;
    dxdt[JR::velocityMps] = (f - s.massKg * PhysicsConstants::G - s.dragNsm * vels) / s.massKg;
    dxdt[JR::heightM] = vels;
}

void ThomsonPlant::outputs(std::span<const float> x, const ThomsonInput&, std::span<float> y) const {
    const float kEnd = s.k0 * std::exp(-x[JR::heightM] * invLambda);
    // Instantaneous force at the state just stored, so the telemetry row and
    // the height it explains are the same sample.
    y[JR::forceN] = x[JR::primaryIA] * x[JR::ringCurrentA] * (-kEnd * sqrtLpLr * invLambda);
    y[JR::couplingK] = kEnd;
}

void ThomsonPlant::save(std::span<float> x) const {
    x[JR::primaryIA] = s.primaryIA;
    x[JR::ringCurrentA] = s.ringCurrentA;
    x[JR::velocityMps] = s.velocityMps;
    x[JR::heightM] = s.heightM;
}

void ThomsonPlant::load(std::span<const float> x) {
    s.primaryIA = x[JR::primaryIA];
    s.ringCurrentA = x[JR::ringCurrentA];
    s.velocityMps = x[JR::velocityMps];
    s.heightM = x[JR::heightM];
}

bool ThomsonPlant::constrain(std::span<float> x) const {
    // Only the velocity component pushing into the stop is removed, so a ring
    // pressed down by the negative half of the force cycle stays put instead
    // of sinking through the core.
    float& h = x[JR::heightM];
    float& vel = x[JR::velocityMps];
    if (h < 0.f) {
        h = 0.f;
        if (vel < 0.f) vel = 0.f;
        return true;
    }
    if (h > s.poleHeightM) {
        h = s.poleHeightM;
        if (vel > 0.f) vel = 0.f;
        return true;
    }
    return false;
}

void SEGSimulator::_stepThomson(float dt) {
    if (!(dt > 0.f) || !std::isfinite(dt)) return;

    ThomsonState& s = _thomson;
    ThomsonPlant plant(s);
    const float drive = clampf(s.drive, 0.f, 1.f);
    // Browser first frames can deliver dt >> 1/60: clamp like the transformer.
    float remaining = dt;
    if (remaining > 0.05f) remaining = 0.05f;

    float x[JR::STATE_SIZE];
    plant.save(x);
    // Accumulated in double for the same reason the transformer plant does it:
    // ~20k substeps per simulated second drift a float phase by ~1e-2 rad, and
    // the TS fallback has no choice but to use double.
    double phase = static_cast<double>(s.phase);
    ThomsonInput u;
    u.omega = static_cast<double>(PhysicsConstants::TAU * s.fHz);
    u.vPeakDrive = static_cast<double>(s.vPeak) * static_cast<double>(drive);

    const sim_core::Integrator method = _odeMethod(JR::INTEGRATOR);
    if (method == sim_core::Integrator::Dopri5 || method == sim_core::Integrator::Ros23) {
        // One adaptive advance over the frame; dense output lands it on dt.
        u.phase0 = phase;
        sim_core::StepperState st{s.stepH, s.stepErrOld};
        _odeStats += sim_core::advance_adaptive(method, plant, std::span<float>(x), u,
                                                static_cast<double>(remaining), JR::tolerance(), st);
        s.stepH = st.h;
        s.stepErrOld = st.errOld;
        phase += u.omega * static_cast<double>(remaining);
    } else {
        // Fixed substeps. Leakage tau = (1−k²)·Lr / Rr is ~0.33 ms at k = 0.65,
        // so the electrical side needs a substep well inside that; the
        // mechanical side (~3 Hz) is along for the ride.
        constexpr float kHTarget = 5.0e-5f;
        constexpr int kSubMax = 800;
        while (remaining > 1e-8f) {
            int nSub = static_cast<int>(std::ceil(remaining / kHTarget));
            if (nSub < 8) nSub = 8;
            if (nSub > kSubMax) nSub = kSubMax;
            const float chunk = remaining > kHTarget * static_cast<float>(kSubMax)
                ? kHTarget * static_cast<float>(kSubMax)
                : remaining;
            const float hStep = chunk / static_cast<float>(nSub);
            const double omegaH = u.omega * static_cast<double>(hStep);
            bool ok = true;
            for (int sub = 0; sub < nSub; ++sub) {
                // t runs from 0 at each substep: vp sees phase, phase + ω·h/2,
                // phase + ω·h — the stage phases the hand-written RK4 used.
                u.phase0 = phase;
                const sim_core::StepStats st = method == sim_core::Integrator::Euler
                    ? sim_core::euler_fixed(plant, 0.0, hStep, std::span<float>(x), u)
                    : sim_core::rk4_fixed(plant, 0.0, hStep, std::span<float>(x), u);
                _odeStats += st;
                if (!st.ok) { ok = false; break; }
                phase += omegaH;
            }
            if (!ok) break;
            remaining -= chunk;
        }
    }

    // Wrap to one period: sin() is unchanged and the stored float keeps full
    // precision however long the bench has been running.
    const double twoPi = 2.0 * static_cast<double>(PhysicsConstants::PI);
    phase = std::fmod(phase, twoPi);
    if (phase < 0.0) phase += twoPi;

    plant.load(x);
    s.phase = static_cast<float>(phase);
    float y[JR::OUTPUT_SIZE];
    plant.outputs(x, u, y);
    s.forceN = y[JR::forceN];
    s.couplingK = y[JR::couplingK];
}

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

using namespace plant_common;

void SEGSimulator::_stepThomson(float dt) {
    if (!(dt > 0.f) || !std::isfinite(dt)) return;

    ThomsonState& s = _thomson;
    const float Lp = s.lPrimaryH;
    const float Lr = s.lRingH;
    const float lpLr = Lp * Lr;
    const float sqrtLpLr = std::sqrt(lpLr > 1e-24f ? lpLr : 1e-24f);
    const float invLambda = 1.f / s.lambdaM;

    const float omega = PhysicsConstants::TAU * s.fHz;
    const float drive = clampf(s.drive, 0.f, 1.f);
    // Leakage tau = (1−k²)·Lr / Rr is ~0.33 ms at k = 0.65, so the electrical
    // side needs a substep well inside that; the mechanical side (~3 Hz) is
    // along for the ride. Browser first frames can deliver dt >> 1/60, so
    // clamp and adapt exactly like the transformer plant.
    float remaining = dt;
    if (remaining > 0.05f) remaining = 0.05f;

    float ip = s.primaryIA;
    float ir = s.ringCurrentA;
    float vel = s.velocityMps;
    float h = s.heightM;
    // Accumulated in double for the same reason the transformer plant does it:
    // ~20k substeps per simulated second drift a float phase by ~1e-2 rad, and
    // the TS fallback has no choice but to use double.
    double phase = static_cast<double>(s.phase);
    constexpr float kHTarget = 5.0e-5f;
    constexpr int kSubMax = 800;
    // D = Lp·Lr − M² is ~1.5e-9 H² for a ring this small, so the transformer's
    // 1e-8 floor would swamp it. Guard only against an actual degenerate k.
    constexpr float kDMin = 1e-13f;

    const double omegaD = static_cast<double>(omega);
    const double vPeakDrive = static_cast<double>(s.vPeak) * static_cast<double>(drive);
    auto driveV = [&](double ph) { return static_cast<float>(vPeakDrive * std::sin(ph)); };

    // One derivative evaluation of [ip, ir, vel, h] at height hs.
    auto deriv = [&](float ips, float irs, float vels, float hs, float vps,
                     float& dip, float& dir, float& dvel, float& dh) {
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
        dip = (Lr * rhsP - M * rhsR) / D;
        dir = (Lp * rhsR - M * rhsP) / D;
        const float f = ips * irs * dMdh;
        dvel = (f - s.massKg * PhysicsConstants::G - s.dragNsm * vels) / s.massKg;
        dh = vels;
    };

    while (remaining > 1e-8f) {
        int nSub = static_cast<int>(std::ceil(remaining / kHTarget));
        if (nSub < 8) nSub = 8;
        if (nSub > kSubMax) nSub = kSubMax;
        const float chunk = remaining > kHTarget * static_cast<float>(kSubMax)
            ? kHTarget * static_cast<float>(kSubMax)
            : remaining;
        const float hStep = chunk / static_cast<float>(nSub);

        bool ok = true;
        const double omegaH = omegaD * static_cast<double>(hStep);
        for (int sub = 0; sub < nSub; ++sub) {
            const float vp = driveV(phase);

            float k1a, k1b, k1c, k1d;
            float k2a, k2b, k2c, k2d;
            float k3a, k3b, k3c, k3d;
            float k4a, k4b, k4c, k4d;
            deriv(ip, ir, vel, h, vp, k1a, k1b, k1c, k1d);
            const float vpm = driveV(phase + 0.5 * omegaH);
            deriv(ip + 0.5f * hStep * k1a, ir + 0.5f * hStep * k1b,
                  vel + 0.5f * hStep * k1c, h + 0.5f * hStep * k1d, vpm,
                  k2a, k2b, k2c, k2d);
            deriv(ip + 0.5f * hStep * k2a, ir + 0.5f * hStep * k2b,
                  vel + 0.5f * hStep * k2c, h + 0.5f * hStep * k2d, vpm,
                  k3a, k3b, k3c, k3d);
            const float vpe = driveV(phase + omegaH);
            deriv(ip + hStep * k3a, ir + hStep * k3b,
                  vel + hStep * k3c, h + hStep * k3d, vpe,
                  k4a, k4b, k4c, k4d);

            const float sixth = hStep / 6.f;
            const float nIp  = ip  + sixth * (k1a + 2.f * k2a + 2.f * k3a + k4a);
            const float nIr  = ir  + sixth * (k1b + 2.f * k2b + 2.f * k3b + k4b);
            const float nVel = vel + sixth * (k1c + 2.f * k2c + 2.f * k3c + k4c);
            const float nH   = h   + sixth * (k1d + 2.f * k2d + 2.f * k3d + k4d);
            if (!std::isfinite(nIp) || !std::isfinite(nIr)
                || !std::isfinite(nVel) || !std::isfinite(nH)) {
                ok = false;
                break;
            }
            ip = nIp;
            ir = nIr;
            vel = nVel;
            h = nH;

            // Rigid stops: the core shoulder the ring starts on, and the top of
            // the pole. Only the velocity component pushing into the stop is
            // removed, so a ring pressed down by the negative half of the force
            // cycle stays put instead of sinking through the core.
            if (h < 0.f) {
                h = 0.f;
                if (vel < 0.f) vel = 0.f;
            } else if (h > s.poleHeightM) {
                h = s.poleHeightM;
                if (vel > 0.f) vel = 0.f;
            }
            phase += omegaH;
        }
        if (!ok) break;
        remaining -= chunk;
    }

    // Wrap to one period: sin() is unchanged and the stored float keeps full
    // precision however long the bench has been running.
    const double twoPi = 2.0 * static_cast<double>(PhysicsConstants::PI);
    phase = std::fmod(phase, twoPi);
    if (phase < 0.0) phase += twoPi;

    const float kEnd = s.k0 * std::exp(-h * invLambda);
    s.primaryIA = ip;
    s.ringCurrentA = ir;
    s.velocityMps = vel;
    s.heightM = h;
    s.phase = static_cast<float>(phase);
    // Reported force is the instantaneous one at the state just stored, so the
    // telemetry row and the height it explains are the same sample.
    s.forceN = ip * ir * (-kEnd * sqrtLpLr * invLambda);
    s.couplingK = kEnd;
}

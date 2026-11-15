#pragma once
// Thomson jumping ring: AC primary on a laminated core, aluminium ring as a
// shorted single-turn secondary that carries mass and gravity. Mutual
// inductance M(x) = k(x)*sqrt(Lp*Lr) falls with height, so the lift decays as
// the ring rises and the ring settles at a hover instead of leaving the pole.
//
// Educational Lenz's-law demo. There is no thermal state here at all — the
// ring never heats, glows or melts — and no eddy-current field solver.
// Mirrors JUMPING_RING in devices/quanta/jumping-ring.ts.
// Classroom numbers: physics/constants.json -> generated/constants.h.

#include "../../../generated/constants.h"
#include "../../../generated/plant-ode.h"

#include <cstddef>
#include <span>

struct ThomsonState {
    float primaryIA{0.f};   // primary winding current, A
    float ringCurrentA{0.f};// induced ring current, A (a shorted single turn)
    float heightM{0.f};     // ring height above the core shoulder, m
    float velocityMps{0.f}; // ring vertical velocity, m/s
    float forceN{0.f};      // derived net magnetic force on the ring, N
    float couplingK{power_gen::JumpingRingConstants::COUPLING_K0}; // k(h)
    float phase{0.f};       // rad, omega*t of the mains drive

    // The primary runs at the lab mains frequency rather than a literal of its
    // own, so the transformer bench and this one cannot drift apart.
    float fHz{power_gen::TransformerConstants::F_HZ};
    float lPrimaryH{power_gen::JumpingRingConstants::PRIMARY_L_H};
    float rPrimaryOhm{power_gen::JumpingRingConstants::PRIMARY_R_OHM};
    float vPeak{power_gen::JumpingRingConstants::PRIMARY_V_PEAK};
    float lRingH{power_gen::JumpingRingConstants::RING_L_H};
    float rRingOhm{power_gen::JumpingRingConstants::RING_R_OHM};
    float massKg{power_gen::JumpingRingConstants::RING_MASS_KG};
    float k0{power_gen::JumpingRingConstants::COUPLING_K0};
    float lambdaM{power_gen::JumpingRingConstants::COUPLING_LAMBDA_M}; // k(h) decay length
    float dragNsm{power_gen::JumpingRingConstants::DRAG_NSM};
    float poleHeightM{power_gen::JumpingRingConstants::POLE_HEIGHT_M}; // rigid stop at the pole top
    float heightRefM{power_gen::JumpingRingConstants::HEIGHT_REF_M};   // display normaliser
    float iPrimaryMaxA{power_gen::JumpingRingConstants::I_PRIMARY_MAX_A};
    float iRingMaxA{power_gen::JumpingRingConstants::I_RING_MAX_A};
    float drive{0.f};
    // Adaptive-integrator carry-over (core/integrate.h StepperState): the
    // next step size and the PI controller's last error. Saved in snapshots.
    float stepH{0.f};
    float stepErrOld{1e-4f};
};

/// What one advance holds constant: the drive's phase at t = 0 and its
/// amplitude. vp(t) = vPeakDrive · sin(phase0 + omega·t), evaluated in double
/// so ~20k substeps per second do not drift the phase.
struct ThomsonInput {
    double phase0{0.0};
    double omega{0.0};
    double vPeakDrive{0.0};
};

/// sim_core::Plant view over a ThomsonState (cpp/src/core/plant.h).
/// x = [primaryIA, ringCurrentA, velocityMps, heightM] (generated enum).
struct ThomsonPlant {
    using ode = power_gen::ode::JumpingRing;
    using input_type = ThomsonInput;
    static constexpr std::size_t state_size = ode::STATE_SIZE;
    static constexpr std::size_t output_size = ode::OUTPUT_SIZE;

    explicit ThomsonPlant(ThomsonState& st);

    void derivs(double t, std::span<const float> x, const ThomsonInput& u, std::span<float> dxdt) const;
    /// y = [forceN, couplingK] at x: the instantaneous force and k(h).
    void outputs(std::span<const float> x, const ThomsonInput& u, std::span<float> y) const;
    void save(std::span<float> x) const;
    void load(std::span<const float> x);
    /// Rigid stops: the core shoulder (h = 0) and the pole top.
    bool constrain(std::span<float> x) const;

    ThomsonState& s;
    float lpLr;
    float sqrtLpLr;
    float invLambda;
};

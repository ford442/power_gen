// =============================================================
// maglev_plant.cpp  –  Quanta magnetic-levitation gap ODE (pure
// extraction, no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void SEGSimulator::_stepMaglev(float dt) {
    using MC = power_gen::MaglevConstants;
    MaglevState& m = _maglev;
    float gapTarget = MC::GAP_TARGET_BASE_M + MC::GAP_TARGET_SPAN_M * m.drive;
    float gap = m.gap;
    float vel = m.gapVel;
    float lift = m.kSpring * (gapTarget - gap) * (MC::LIFT_DRIVE_BASE + MC::LIFT_DRIVE_SPAN * m.drive);
    float grav = m.mass * PhysicsConstants::G;
    float accel = (lift - grav) / m.mass;
    // Semi-implicit Euler with the eddy-damping term taken *implicitly*, the
    // same treatment the Lorentz sled gives its linear-in-v terms. Explicit
    // damping is unstable here: c·dt/m = 14·(1/60)/0.045 ≈ 5.2 ≫ 2, which
    // turned the floater into a period-2 orbit slapping the 4 mm / 60 mm
    // clamps every frame instead of levitating. Backward Euler on that one
    // term is unconditionally stable, and the spring stays explicit
    // (ω·dt ≈ 0.97 < 2).
    float newVel = (vel + accel * dt) / (1.f + (m.cDamp / m.mass) * dt);
    float newGap = gap + newVel * dt;
    if (newGap < MC::GAP_MIN_M) { newGap = MC::GAP_MIN_M; newVel = std::max(0.f, newVel); }
    if (newGap > MC::GAP_MAX_M) { newGap = MC::GAP_MAX_M; newVel = std::min(0.f, newVel); }
    m.gap = newGap;
    m.gapVel = newVel;
    m.gapMm = newGap * 1000.f;
    m.fieldT = estimateHalbachFieldT(newGap);
    m.liftN = std::max(0.f, lift);
    float err = std::abs(newGap - gapTarget) / std::max(gapTarget, 0.01f);
    m.rpm = m.drive * MC::RPM_MAX * (MC::RPM_ERR_BASE + MC::RPM_ERR_SPAN * (1.f - err));
}

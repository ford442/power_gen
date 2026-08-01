// =============================================================
// maglev_plant.cpp  –  Quanta magnetic-levitation gap ODE (pure
// extraction, no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void SEGSimulator::_stepMaglev(float dt) {
    MaglevState& m = _maglev;
    float gapTarget = 0.012f + 0.022f * m.drive;
    float gap = m.gap;
    float vel = m.gapVel;
    float lift = m.kSpring * (gapTarget - gap) * (0.6f + 0.4f * m.drive);
    float grav = m.mass * PhysicsConstants::G;
    float accel = (lift - grav - m.cDamp * vel) / m.mass;
    // Semi-implicit Euler: update velocity first, then integrate position.
    float newVel = vel + accel * dt;
    float newGap = gap + newVel * dt;
    if (newGap < 0.004f) { newGap = 0.004f; newVel = std::max(0.f, newVel); }
    if (newGap > 0.06f)  { newGap = 0.06f;  newVel = std::min(0.f, newVel); }
    m.gap = newGap;
    m.gapVel = newVel;
    m.gapMm = newGap * 1000.f;
    m.fieldT = estimateHalbachFieldT(newGap);
    m.liftN = std::max(0.f, lift);
    float err = std::abs(newGap - gapTarget) / std::max(gapTarget, 0.01f);
    m.rpm = m.drive * 4200.f * (0.3f + 0.7f * (1.f - err));
}

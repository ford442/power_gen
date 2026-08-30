// =============================================================
// hall_plant.cpp – Hall-effect sensor bench: I, B → Hall voltage
// V_H = I·B/(n·e·t), R_H = 1/(n·e). Mirrors devices/quanta/hall-effect.ts
// (HALL constants + stepHallPhysics) — algebraic derived quantities each
// step, same shape as _stepMHD (no ODE stiffness here either).
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

namespace {
// CODATA elementary charge (C).
constexpr float ELEMENTARY_CHARGE = 1.602176634e-19f;
// Carrier density (m^-3) / strip thickness (m) per classroom sample —
// mirrors HALL_CARRIER_PROFILES in devices/quanta/hall-effect.ts.
constexpr float N_SEMICONDUCTOR = 1.0e21f;
constexpr float T_SEMICONDUCTOR_M = 5.0e-4f;
constexpr float N_METAL = 8.5e28f;
constexpr float T_METAL_M = 1.0e-4f;
}

void SEGSimulator::setHallCarrierMetal(bool metal) {
    _hall.carrierMetal = metal;
}

void SEGSimulator::_stepHall(float dt) {
    HallState& h = _hall;
    const float d = clampf(h.drive, 0.f, 1.f);

    // Both I and B track the shared drive control, smoothed so slider moves
    // read as a brief transient rather than a step.
    const float iTarget = d * h.iMaxA;
    const float bTarget = d * h.bMaxT;
    const float alpha = std::min(1.f, dt / h.smoothingTau);
    h.current += (iTarget - h.current) * alpha;
    h.fieldT  += (bTarget - h.fieldT) * alpha;

    const float n = h.carrierMetal ? N_METAL : N_SEMICONDUCTOR;
    const float t = h.carrierMetal ? T_METAL_M : T_SEMICONDUCTOR_M;
    h.voltage = (h.current * h.fieldT) / (n * ELEMENTARY_CHARGE * t);
    h.coeff = 1.f / (n * ELEMENTARY_CHARGE);
}

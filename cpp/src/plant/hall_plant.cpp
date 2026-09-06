// =============================================================
// hall_plant.cpp – Hall-effect sensor bench: I, B → Hall voltage
// V_H = I·B/(n·e·t), R_H = 1/(n·e). Mirrors devices/quanta/hall-effect.ts
// (HALL constants + stepHallPhysics) — algebraic derived quantities each
// step, same shape as _stepMHD (no ODE stiffness here either).
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

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

    const float n = h.carrierMetal
        ? power_gen::HallConstants::N_METAL
        : power_gen::HallConstants::N_SEMICONDUCTOR;
    const float t = h.carrierMetal
        ? power_gen::HallConstants::T_METAL_M
        : power_gen::HallConstants::T_SEMICONDUCTOR_M;
    const float e = PhysicsConstants::E_CHARGE;
    h.voltage = (h.current * h.fieldT) / (n * e * t);
    h.coeff = 1.f / (n * e);
}

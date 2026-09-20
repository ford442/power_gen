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

// Lab field coupling (ADR-0011). t < 0 clears the coupling and returns the
// bench to its drive-derived B — the default, so goldens are untouched unless
// a caller opts in. Mirrors hallFieldTargetT in devices/quanta/hall-effect.ts.
void SEGSimulator::setHallFieldCoupledT(float fieldT) {
    _hall.fieldCoupledT = (fieldT >= 0.f)
        ? clampf(fieldT, 0.f, _hall.bMaxT)
        : -1.f;
}

void SEGSimulator::_stepHall(float dt) {
    HallState& h = _hall;
    const float d = clampf(h.drive, 0.f, 1.f);

    // I tracks the shared drive control; B tracks it too unless the lab field
    // network has supplied a coupled setpoint. Both smoothed with the same tau,
    // so a slider move — or a coupling toggle — reads as a brief transient.
    const float iTarget = d * h.iMaxA;
    const float bTarget = (h.fieldCoupledT >= 0.f) ? h.fieldCoupledT : d * h.bMaxT;
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

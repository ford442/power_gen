// =============================================================
// lorentz_plant.cpp – Lorentz rail sled: series R–L drive loop closed
// through a sliding armature on two rails.
//
//   L dI/dt = V_drive − I·R − B·l·v        (back-EMF)
//   m dv/dt = I·l·B − mu·m·g·tanh(v/v_eps) − b·v
//   dx/dt   = v                            (reported modulo railLengthM)
//
// Mirrors LORENTZ + stepLorentzSledPhysics in
// devices/quanta/lorentz-sled.ts term for term.
//
// Educational Lorentz-force model — a low-voltage bench rail motor, not a
// railgun design tool. No projectile, muzzle energy, or ballistics here.
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void SEGSimulator::setLorentzFieldT(float fieldT) {
    _lorentz.fieldT = clampf(fieldT, 0.f, _lorentz.fieldTMax);
}

void SEGSimulator::_stepLorentz(float dt) {
    LorentzState& s = _lorentz;
    const float d = clampf(s.drive, 0.f, 1.f);
    const float bl = s.fieldT * s.railGapM;

    const float vSupply = d * s.supplyVMax;

    // Velocity first, with every term linear in v taken implicitly: viscous
    // drag *and* the back-EMF reaction (B*l)^2/R (the current's own response to
    // the sled speeding up). tau = L/R (~100 us) is far shorter than a render
    // substep, so within one step the current tracks (V - B*l*v)/R and that
    // reaction acts as extra linear damping. Backward Euler on those terms is
    // unconditionally stable; explicit Euler blows up on a long frame.
    //
    // Coulomb friction is regularised with tanh so the sign flip at v = 0 does
    // not chatter (no static-friction latch — the sled creeps instead).
    const float coulomb = s.frictionMu * s.massKg * PhysicsConstants::G
                        * std::tanh(s.velocityMps / s.vEpsMps);
    const float accel = ((vSupply * bl) / s.rOhm - coulomb) / s.massKg;
    const float damping = ((bl * bl) / s.rOhm + s.viscousNsm) / s.massKg;
    s.velocityMps = (s.velocityMps + accel * dt) / (1.f + damping * dt);

    // Analytic R-L relaxation toward the steady current at the new speed —
    // exact for constant V and v, and stable at any dt.
    const float iSteady = (vSupply - bl * s.velocityMps) / s.rOhm;
    const float decay = std::exp(-(dt * s.rOhm) / s.lHenry);
    s.currentA = iSteady + (s.currentA - iSteady) * decay;
    s.forceN = s.currentA * bl;

    // Reported position wraps; the ODE state (I, v) stays continuous.
    s.positionM += s.velocityMps * dt;
    s.positionM = std::fmod(s.positionM, s.railLengthM);
    if (s.positionM < 0.f) s.positionM += s.railLengthM;
}

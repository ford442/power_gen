// =============================================================
// mhd_plant.cpp  –  Hartmann MHD duct: lumped mean-speed plant + parcels
// that advect on the analytic Hartmann profile (mhd_plant.h)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void mhd_particle_step(SimParticle& p, float flowU, float bField, float hartmannNumber, float dt, float /*simTime*/) {
    // Fully developed Hartmann flow: a parcel keeps its lane (y, z) and
    // advects along +x at the local speed u(y) = flowU · profile(y/a; Ha).
    // There is no cross-stream motion — the laminar solution has none — so
    // parcels released together across the gap spread into the profile.
    // Scene units per second on the slowed display clock (mhd-parcels.ts).
    using namespace mhd_scene;
    const float eta = clampf(p.y / HALF_GAP_U, -1.f, 1.f);
    const float uMps = std::max(0.f, flowU) * hartmann::profile(eta, hartmannNumber);
    p.vx = uMps * (LENGTH_U / power_gen::MhdConstants::LENGTH_M) / SLOWDOWN;
    p.vy = 0.f; p.vz = 0.f;
    p.x += p.vx * dt;
    p.aux = clampf(bField * uMps * 0.4f, 0.f, 1.f); // induction glow ∝ local u·B
    // Re-enter at the inlet on the same lane; a non-finite x re-seeds there too.
    if (!(p.x <= X_IN + LENGTH_U)) p.x = X_IN + std::fmod(p.x - X_IN, LENGTH_U);
    if (!(p.x >= X_IN) || !std::isfinite(p.x)) p.x = X_IN;
}

void SEGSimulator::_stepMHD(float dt) {
    // Pump against the profile's own wall friction and the Lorentz force on
    // the current the load draws (mhd_plant.h → mhd_duct); V_oc = B·u·w
    // across the fluid's resistance and the load.
    MHDState& m = _mhd;
    m.bFieldT = m.bFieldBaseT + m.bFieldSpanT * m.drive;
    m.hartmann = mhd_duct::hartmann_number(m, m.bFieldT);
    // dU/dt = A − k·U with k up to several hundred per second: stepped exactly
    // (the rates are constant over a step), which no step size can destabilise.
    const float rate = mhd_duct::friction_rate(m, m.hartmann) + mhd_duct::braking_rate(m, m.bFieldT);
    const float settled = m.drive * m.pumpAccel / rate;
    m.flowU = clampf(settled + (m.flowU - settled) * std::exp(-rate * std::max(dt, 0.f)), 0.f, m.flowUMax * 2.f);
    float vOpen = m.bFieldT * m.flowU * m.widthM;
    m.currentA = vOpen / (mhd_duct::internal_ohm(m) + m.rLoadOhm);
    m.voltageV = m.currentA * m.rLoadOhm;
    m.powerW   = m.currentA * m.voltageV;
}

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
    // Pressure-driven channel flow with Lorentz braking (σB²u/ρ) and wall
    // friction; induced load voltage V = B·u·w through a resistive divider.
    MHDState& m = _mhd;
    m.bFieldT = m.bFieldBaseT + m.bFieldSpanT * m.drive;
    float accel = m.drive * m.pumpAccel
                - (m.lorentzK * m.bFieldT * m.bFieldT + m.frictionK) * m.flowU;
    m.flowU = clampf(m.flowU + accel * dt, 0.f, m.flowUMax * 2.f);
    float vOpen = m.bFieldT * m.flowU * m.widthM;
    m.currentA = vOpen / (m.rInternalOhm + m.rLoadOhm);
    m.voltageV = m.currentA * m.rLoadOhm;
    m.powerW   = m.currentA * m.voltageV;
    m.hartmann = m.bFieldT * m.halfGapM * std::sqrt(m.sigmaSm / (m.rhoKgM3 * m.nuM2s));
}

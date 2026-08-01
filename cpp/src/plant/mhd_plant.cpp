// =============================================================
// mhd_plant.cpp  –  Hartmann-style MHD channel plant (pure extraction,
// no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void mhd_particle_step(SimParticle& p, float flowU, float bField, float dt, float simTime) {
    // Channel advection along +x with Lorentz-scaled helical swirl; recycle
    // parcels at the inlet (x = -2.2) once they exit the duct.
    constexpr float X_OUT = 2.2f;
    constexpr float HY = 1.2f;  // half-height
    constexpr float HZ = 0.9f;  // half-depth
    float uTarget = std::max(0.05f, flowU) * 1.2f;
    p.vx += (uTarget - p.vx) * 3.f * dt;
    // Transverse confinement + B-scaled swirl around the flow axis
    float swirl = bField * 1.4f;
    float aY = -p.y * 6.f - p.vy * 2.f + swirl * p.z * 2.f
             + std::sin(p.phase * 37.1f + simTime * 1.3f) * 0.2f;
    float aZ = -p.z * 6.f - p.vz * 2.f - swirl * p.y * 2.f;
    p.vy += aY * dt; p.vz += aZ * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.aux = clampf(bField * std::abs(p.vx) * 0.4f, 0.f, 1.f); // induction glow
    if (p.x > X_OUT || std::abs(p.y) > HY * 1.6f || std::abs(p.z) > HZ * 1.6f) {
        p.x = -X_OUT + hash1(p.phase + simTime) * 0.3f;
        p.y = (hash1(p.phase + simTime + 1.f) - 0.5f) * 2.f * HY * 0.8f;
        p.z = (hash1(p.phase + simTime + 2.f) - 0.5f) * 2.f * HZ * 0.8f;
        p.vx = uTarget; p.vy = 0.f; p.vz = 0.f;
    }
}

void SEGSimulator::_stepMHD(float dt) {
    // Pressure-driven channel flow with Lorentz braking (σB²u/ρ) and wall
    // friction; induced load voltage V = B·u·w through a resistive divider.
    MHDState& m = _mhd;
    m.bFieldT = 0.2f + 0.8f * m.drive;
    float accel = m.drive * m.pumpAccel
                - (m.lorentzK * m.bFieldT * m.bFieldT + m.frictionK) * m.flowU;
    m.flowU = clampf(m.flowU + accel * dt, 0.f, m.flowUMax * 2.f);
    float vOpen = m.bFieldT * m.flowU * m.widthM;
    m.currentA = vOpen / (m.rInternalOhm + m.rLoadOhm);
    m.voltageV = m.currentA * m.rLoadOhm;
    m.powerW   = m.currentA * m.voltageV;
    m.hartmann = m.bFieldT * m.halfGapM * std::sqrt(m.sigmaSm / (m.rhoKgM3 * m.nuM2s));
}

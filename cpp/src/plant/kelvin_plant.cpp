// =============================================================
// kelvin_plant.cpp  –  Kelvin water dropper plant (pure extraction, no
// logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void kelvin_particle_step(SimParticle& p, float kelvinE, float dt, float simTime) {
    constexpr float g = PhysicsConstants::G * 0.4f;
    constexpr float stokes = 1.2f;
    // Gravity − Stokes + Coulomb upward accel
    p.vy += (-g + kelvinE * p.aux - stokes * p.vy) * dt;
    p.vx *= (1.f - 0.4f * dt);
    p.vz *= (1.f - 0.4f * dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < -3.f || p.y > 6.f) {
        float side = (hash1(p.phase) > 0.5f) ? 1.f : -1.f;
        p.x = side * 1.2f + (hash1(p.phase + 1.f) - 0.5f) * 0.3f;
        p.y = 3.5f;
        p.z = (hash1(p.phase + 2.f) - 0.5f) * 0.4f;
        p.vx = 0.f; p.vy = -0.5f; p.vz = 0.f;
        // Charge at pinch-off
        p.aux = side * (0.4f + 0.6f * hash1(p.phase + simTime));
    }
}

void SEGSimulator::_stepKelvin(float dt) {
    KelvinState& k = _kelvin;
    constexpr float chargeRate = 8000.f, feedback = 2.f, leak = 0.3f;
    k.voltage += (k.drive * (chargeRate + feedback * k.voltage) - leak * k.voltage) * dt;
    k.voltage = std::max(0.f, k.voltage);
    if (k.voltage >= k.vBreak && k.sparkTimer <= 0.f) {
        k.voltage *= 0.02f;
        k.sparkTimer = k.sparkDur;
    }
    k.sparkTimer = std::max(0.f, k.sparkTimer - dt);
    k.voltageN = clampf(k.voltage / std::max(k.vBreak, 1.f), 0.f, 1.f);
    k.E = 15.f * k.voltageN;
}

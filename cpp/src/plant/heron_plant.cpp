// =============================================================
// heron_plant.cpp  –  Heron's Fountain plant (pure extraction, no logic
// changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void heron_particle_step(SimParticle& p, float vExit, float dt, float simTime) {
    // Gravity + drag; spawn/recycle at jet base when below floor
    constexpr float g = PhysicsConstants::G * 0.35f; // scene-scaled
    constexpr float drag = 0.55f;
    p.vy -= g * dt;
    p.vx *= (1.f - drag * dt);
    p.vz *= (1.f - drag * dt);
    p.vy *= (1.f - drag * 0.35f * dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.aux = std::max(0.f, p.aux - dt); // life
    if (p.y < -2.5f || p.aux <= 0.f) {
        // Respawn as jet droplet
        float a = p.phase * PhysicsConstants::TAU;
        float spray = 0.15f;
        p.x = std::cos(a) * 0.2f;
        p.y = 1.2f;
        p.z = std::sin(a) * 0.2f;
        float ve = std::max(0.2f, vExit);
        p.vx = std::cos(a + 0.5f) * spray * ve;
        p.vy = ve;
        p.vz = std::sin(a + 0.5f) * spray * ve;
        p.aux = 1.5f + 0.5f * hash1(p.phase + simTime);
    }
}

void SEGSimulator::_stepHeron(float dt) {
    // Match device-physics.js + simplified Swamee–Jain / Bernoulli
    HeronState& h = _heron;
    h.head = clampf(h.head + (h.pumpRate * h.drive - h.drainCoeff * h.vExit) * dt,
                    0.f, h.headMax);
    // Bernoulli ideal exit
    float vIdeal = h.dischargeCoeff * std::sqrt(2.f * PhysicsConstants::G * std::max(h.head, 0.f));
    // Pipe friction (Darcy–Weisbach head loss → reduced velocity)
    float D = std::max(h.pipeDiameterM, 1e-4f);
    float L = std::max(h.pipeLengthM, 0.1f);
    float nu = 1.0e-6f; // water kinematic viscosity
    float Re = std::max(1.f, vIdeal * D / nu);
    float f = swameeJainF(Re, h.roughnessM, D);
    float hf = f * (L / D) * (vIdeal * vIdeal) / (2.f * PhysicsConstants::G);
    float hEff = std::max(0.f, h.head - hf * 0.15f); // partial loss coupling
    h.vExit = h.dischargeCoeff * std::sqrt(2.f * PhysicsConstants::G * hEff);
    h.reynolds = Re;
    // Q = v * A
    float A = PhysicsConstants::PI * (D * 0.5f) * (D * 0.5f);
    h.flowLmin = h.vExit * A * 60000.f; // m³/s → L/min
    h.pressureKPa = 1000.f * PhysicsConstants::G * h.head / 1000.f; // ρgh in kPa
    h.reynolds = Re;
}

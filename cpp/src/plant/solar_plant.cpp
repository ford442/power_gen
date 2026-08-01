// =============================================================
// solar_plant.cpp  –  LED/solar plant (pure extraction, no logic changes
// vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void solar_particle_step(SimParticle& p, float transmittance, float dt, float /*simTime*/) {
    // Ballistic photons from LED plane (y=2) toward panel (y=-1)
    constexpr float c = 8.f; // scene light speed
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    // Hit panel plane
    if (p.y < -1.f && p.aux < 0.5f) {
        // Fresnel absorb vs reflect
        float absorb = transmittance * 8.f; // scale
        if (hash1(p.phase * 3.1f) < absorb) {
            p.aux = 1.f; // absorbed
            p.vx = p.vy = p.vz = 0.f;
        } else {
            p.vy = std::abs(p.vy) * 0.6f;
            p.aux = 0.25f; // reflected
        }
    }
    if (p.y > 4.f || p.y < -3.f || std::abs(p.x) > 6.f) {
        // Respawn at LED hex
        float a = p.phase * PhysicsConstants::TAU;
        p.x = std::cos(a) * 0.8f;
        p.y = 2.0f;
        p.z = std::sin(a) * 0.8f;
        p.vx = (hash1(p.phase) - 0.5f) * 0.4f;
        p.vy = -c;
        p.vz = (hash1(p.phase + 1.f) - 0.5f) * 0.4f;
        p.aux = 0.f;
    }
}

void SEGSimulator::_stepSolar(float dt) {
    SolarState& s = _solar;
    float ledPower = s.ledPower;
    float gain = s.transmittance * ledPower * s.opticalEff;
    float drainW = ledPower * s.ledWallPlug;
    s.batteryCharge = clampf(s.batteryCharge + (gain - drainW) * dt, 0.f, 1.f);
}

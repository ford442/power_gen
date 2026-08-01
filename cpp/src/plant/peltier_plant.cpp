// =============================================================
// peltier_plant.cpp  –  Peltier thermoelectric stack plant (pure
// extraction, no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void peltier_particle_step(SimParticle& p, float deltaTN, float dt, float simTime) {
    // Convection cell in the stack cavity: hot plate at y=-0.9 heats parcels
    // (aux → 1), buoyancy lifts them, the cold plate at y=+0.9 cools them
    // (aux → 0) and they sink. Circulation strength scales with ΔT.
    constexpr float H = 0.9f;   // half-height
    constexpr float W = 1.6f;   // half-width (x)
    constexpr float D = 1.3f;   // half-depth (z)
    float heat = clampf((-p.y + H * 0.6f) / (0.8f * H), 0.f, 1.f); // near hot plate
    float cool = clampf((p.y - H * 0.2f) / (0.8f * H), 0.f, 1.f);  // near cold plate
    p.aux += (heat * 2.2f - cool * 2.6f - 0.15f) * deltaTN * dt;
    p.aux = clampf(p.aux, 0.f, 1.f);
    // Buoyancy: hot parcels rise, cold sink
    float aY = (p.aux - 0.45f) * 5.5f * deltaTN - p.vy * 1.8f;
    // Horizontal recirculation: drift outward near top, inward near bottom
    float loopX = (p.y > 0.f ? 1.f : -1.f) * (p.x >= 0.f ? 1.f : -1.f);
    float aX = loopX * 0.9f * deltaTN - p.vx * 1.6f - p.x * 0.35f;
    float aZ = std::sin(p.phase * 21.7f + simTime * 0.9f) * 0.25f * deltaTN
             - p.vz * 1.6f - p.z * 0.4f;
    p.vx += aX * dt; p.vy += aY * dt; p.vz += aZ * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (std::abs(p.x) > W || std::abs(p.y) > H || std::abs(p.z) > D) {
        p.x = (hash1(p.phase + simTime) - 0.5f) * 2.f * W * 0.9f;
        p.y = -H * 0.85f;
        p.z = (hash1(p.phase + simTime + 1.f) - 0.5f) * 2.f * D * 0.9f;
        p.vx = p.vy = p.vz = 0.f;
        p.aux = 0.2f;
    }
}

void SEGSimulator::_stepPeltier(float dt) {
    // Two-node lumped stack: heater → hot junction, sink → ambient.
    // Seebeck generation with Peltier back-pumping and half/half Joule split;
    // Thomson term neglected (simplified 1D model).
    PeltierState& s = _peltier;
    float S = s.seebeck * s.couples;               // effective module V/K
    s.deltaTK = s.hotK - s.coldK;
    float I = S * s.deltaTK / (s.rInternalOhm + s.rLoadOhm);
    float qHeater = s.drive * s.heaterMaxW;
    float qCond   = s.conductanceWK * s.deltaTK;
    float qJoule  = 0.5f * I * I * s.rInternalOhm;
    float dTh = (qHeater - qCond - S * I * s.hotK  + qJoule) / s.heatCapHotJK;
    float dTc = (qCond   + S * I * s.coldK + qJoule
                 - s.sinkWK * (s.coldK - s.ambientK)) / s.heatCapColdJK;
    s.hotK  = clampf(s.hotK  + dTh * dt, s.ambientK - 5.f, s.ambientK + 250.f);
    s.coldK = clampf(s.coldK + dTc * dt, s.ambientK - 5.f, s.ambientK + 150.f);
    s.deltaTK  = s.hotK - s.coldK;
    s.currentA = S * s.deltaTK / (s.rInternalOhm + s.rLoadOhm);
    s.voltageV = s.currentA * s.rLoadOhm;
    s.powerW   = s.currentA * s.voltageV;
    s.cop      = qHeater > 1e-3f ? clampf(s.powerW / qHeater, 0.f, 1.f) : 0.f;
}

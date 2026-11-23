// =============================================================
// particles.cpp  –  mode-aware particle seeding / stepping + particle
// accessors
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <vector>

using namespace plant_common;

void SEGSimulator::seedParticles(int count) {
    _numParticles = (count < 0) ? 0 :
                    (count > MAX_PARTICLES) ? MAX_PARTICLES : count;
    _particles.assign(static_cast<size_t>(_numParticles), SimParticle{});
    for (int i = 0; i < _numParticles; ++i) {
        uint32_t idx = static_cast<uint32_t>(i);
        SimParticle& p = _particles[i];
        p.phase = rnd(idx, 3.f);
        if (_mode == SIM_MODE_SEG) {
            int ring = i % 3;
            float R = RING_RADII[ring];
            float a = rnd(idx, 1.f) * PhysicsConstants::TAU;
            float vT = _rollers[0].omega * R * 1.2f;
            p.x = std::cos(a) * R; p.y = (rnd(idx, 2.f) - 0.5f) * 1.6f; p.z = std::sin(a) * R;
            p.vx = -std::sin(a) * vT; p.vy = 0.f; p.vz = std::cos(a) * vT; p.aux = 0.f;
        } else if (_mode == SIM_MODE_HERON) {
            float a = rnd(idx, 1.f) * PhysicsConstants::TAU;
            p.x = std::cos(a) * 0.2f; p.y = 1.2f + rnd(idx, 2.f); p.z = std::sin(a) * 0.2f;
            p.vx = 0.f; p.vy = _heron.vExit / power_gen::HeronConstants::METRES_PER_SCENE_UNIT; p.vz = 0.f; p.aux = 1.5f;
        } else if (_mode == SIM_MODE_KELVIN) {
            float side = (rnd(idx, 1.f) > 0.5f) ? 1.f : -1.f;
            p.x = side * 1.2f; p.y = 3.5f - rnd(idx, 2.f) * 2.f; p.z = 0.f;
            p.vx = 0.f; p.vy = -0.5f; p.vz = 0.f; p.aux = side * 0.7f;
        } else if (_mode == SIM_MODE_PELTIER) {
            // A ring of air beside each end body: z ≥ 0 the cold block (above),
            // z < 0 the heat sink (below) — peltier_particle_step.
            const float a = rnd(idx, 1.f) * PhysicsConstants::PI * ((i & 1) ? 1.f : -1.f);
            const float r = 0.95f + rnd(idx, 4.f) * 0.5f;
            p.x = std::cos(a) * r;
            p.z = std::sin(a) * r;
            p.y = (p.z >= 0.f ? 2.5f : -2.5f) + (rnd(idx, 2.f) - 0.5f) * 2.6f;
            p.vx = p.vy = p.vz = 0.f;
            p.aux = 0.5f;
        } else if (_mode == SIM_MODE_MHD) {
            // Lanes fill the drawn duct; each parcel keeps its (y, z) for good.
            p.x = mhd_scene::X_IN + rnd(idx, 1.f) * mhd_scene::LENGTH_U;
            p.y = (rnd(idx, 2.f) - 0.5f) * 2.f * mhd_scene::HALF_GAP_U;
            p.z = (rnd(idx, 4.f) - 0.5f) * 2.f * mhd_scene::HALF_WIDTH_U;
            p.vx = 0.f; p.vy = 0.f; p.vz = 0.f; p.aux = 0.f;
        } else { // solar
            float a = rnd(idx, 1.f) * PhysicsConstants::TAU;
            p.x = std::cos(a) * 0.8f; p.y = 2.0f; p.z = std::sin(a) * 0.8f;
            p.vx = 0.f; p.vy = -8.f; p.vz = 0.f; p.aux = 0.f;
        }
    }
}

void SEGSimulator::stepParticles(float dt) {
    float omega  = (_numRollers > 0) ? _rollers[0].omega : 0.f;
    float corona = clampf((omega - 0.6f * 50.f) / (0.4f * 50.f), 0.f, 1.f); // rough if omega in rad/s
    // Prefer corona from normalized plant when available
    if (_mode == SIM_MODE_SEG) {
        float wN = clampf(omega / 50.f, 0.f, 1.f);
        corona = clampf((wN - 0.6f) / 0.4f, 0.f, 1.f);
    }
    for (int i = 0; i < _numParticles; ++i) {
        SimParticle& p = _particles[i];
        switch (_mode) {
            case SIM_MODE_SEG:
                seg_particle_step(p, omega, corona, dt);
                {
                    float rXZ = std::sqrt(p.x*p.x + p.z*p.z);
                    if (rXZ < 1.f || rXZ > 11.f || std::abs(p.y) > 5.f) {
                        uint32_t idx = static_cast<uint32_t>(i);
                        int ring = i % 3;
                        float R = RING_RADII[ring];
                        float a = rnd(idx, _time + 1.f) * PhysicsConstants::TAU;
                        float vT = omega * R * 1.2f;
                        p.x = std::cos(a) * R; p.y = (rnd(idx, _time + 2.f) - 0.5f) * 1.6f; p.z = std::sin(a) * R;
                        p.vx = -std::sin(a) * vT; p.vy = 0.f; p.vz = std::cos(a) * vT;
                    }
                }
                break;
            case SIM_MODE_HERON:
                heron_particle_step(p, _heron.vExit, dt, _time);
                break;
            case SIM_MODE_KELVIN:
                kelvin_particle_step(p, _kelvin.E, dt, _time);
                break;
            case SIM_MODE_SOLAR:
                solar_particle_step(p, _solar.transmittance, dt, _time);
                break;
            case SIM_MODE_PELTIER:
                peltier_particle_step(p,
                    (_peltier.nodesK[PeltierState::SINK] - _peltier.ambientK) / _peltier.deltaTRefK,
                    (_peltier.nodesK[PeltierState::COLD_BLOCK] - _peltier.ambientK) / _peltier.deltaTRefK,
                    dt, _time);
                break;
            case SIM_MODE_MHD:
                mhd_particle_step(p, _mhd.flowU, _mhd.bFieldT, _mhd.hartmann, dt, _time);
                break;
        }
    }
}

SimParticle SEGSimulator::getParticle(int i) const {
    if (i < 0 || i >= _numParticles) return {};
    return _particles[i];
}

uintptr_t SEGSimulator::getParticleBufferPtr() const {
    return reinterpret_cast<uintptr_t>(_particles.data());
}

int SEGSimulator::getParticleFloatCount() const {
    return _numParticles * 8; // 8 floats per SimParticle
}

uintptr_t SEGSimulator::getRollerStatePtr() const {
    return reinterpret_cast<uintptr_t>(_rollerExport);
}

int SEGSimulator::getRollerStateFloatCount() const {
    return _numRollers * ROLLER_EXPORT_STRIDE;
}

// =============================================================
// particles.cpp  –  mode-aware particle seeding / stepping + particle
// accessors (pure extraction, no logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <vector>

using namespace plant_common;

void SEGSimulator::seedParticles(int count) {
    _numParticles = (count < 0) ? 0 :
                    (count > MAX_PARTICLES) ? MAX_PARTICLES : count;
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
            p.vx = 0.f; p.vy = _heron.vExit; p.vz = 0.f; p.aux = 1.5f;
        } else if (_mode == SIM_MODE_KELVIN) {
            float side = (rnd(idx, 1.f) > 0.5f) ? 1.f : -1.f;
            p.x = side * 1.2f; p.y = 3.5f - rnd(idx, 2.f) * 2.f; p.z = 0.f;
            p.vx = 0.f; p.vy = -0.5f; p.vz = 0.f; p.aux = side * 0.7f;
        } else if (_mode == SIM_MODE_PELTIER) {
            p.x = (rnd(idx, 1.f) - 0.5f) * 3.f;
            p.y = (rnd(idx, 2.f) - 0.5f) * 1.6f;
            p.z = (rnd(idx, 4.f) - 0.5f) * 2.4f;
            p.vx = p.vy = p.vz = 0.f;
            p.aux = rnd(idx, 5.f);
        } else if (_mode == SIM_MODE_MHD) {
            p.x = (rnd(idx, 1.f) - 0.5f) * 4.2f;
            p.y = (rnd(idx, 2.f) - 0.5f) * 1.9f;
            p.z = (rnd(idx, 4.f) - 0.5f) * 1.4f;
            p.vx = _mhd.flowU; p.vy = 0.f; p.vz = 0.f; p.aux = 0.f;
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
                peltier_particle_step(p, clampf(_peltier.deltaTK / _peltier.deltaTRefK, 0.f, 1.f), dt, _time);
                break;
            case SIM_MODE_MHD:
                mhd_particle_step(p, _mhd.flowU, _mhd.bFieldT, dt, _time);
                break;
        }
    }
}

SimParticle SEGSimulator::getParticle(int i) const {
    if (i < 0 || i >= _numParticles) return {};
    return _particles[i];
}

std::vector<SimParticle> SEGSimulator::getParticles(int maxCount) const {
    int n = _numParticles;
    if (maxCount >= 0 && maxCount < n) n = maxCount;
    std::vector<SimParticle> out;
    out.reserve(n);
    for (int i = 0; i < n; ++i) out.push_back(_particles[i]);
    return out;
}

uintptr_t SEGSimulator::getParticleBufferPtr() const {
    return reinterpret_cast<uintptr_t>(_particles);
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

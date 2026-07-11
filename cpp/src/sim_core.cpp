// =============================================================
// sim_core.cpp  –  SEG simulation core implementation
// =============================================================

#include "sim_core.h"

#ifdef __EMSCRIPTEN__
#  include <emscripten/bind.h>
#  include <string>
using namespace emscripten;
#endif

#include <cstdlib>
#include <ctime>
#include <vector>
#include <algorithm>

// ─────────────────────────────────────────────────────────────
namespace {

inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static uint32_t lcg_state = 0x12345678u;
inline float lcg_rand() {
    lcg_state = lcg_state * 1664525u + 1013904223u;
    return static_cast<float>(lcg_state >> 8) / static_cast<float>(1u << 24);
}

inline int rollerIndexToRing(int idx) {
    if (idx < 12) return 0;
    if (idx < 12 + 22) return 1;
    return 2;
}

inline float hash1(float n) {
    float v = std::sin(n * 78.233f + 12.9898f) * 43758.5453f;
    return v - std::floor(v);
}
inline float rnd(uint32_t idx, float salt, float simClock = 0.f) {
    return hash1(static_cast<float>(idx) * 0.1031f + salt * 1.7f + simClock * 0.37f);
}

/// Swamee–Jain friction factor (approximate) for turbulent pipe flow.
inline float swameeJainF(float Re, float eps, float D) {
    if (Re < 1.f) return 0.05f;
    float a = eps / (3.7f * D);
    float b = 5.74f / std::pow(Re, 0.9f);
    float invSqrt = -2.f * std::log10(a + b);
    float f = 1.f / (invSqrt * invSqrt);
    return clampf(f, 0.008f, 0.1f);
}

} // anonymous namespace

// ─────────────────────────────────────────────────────────────
// Magnetic field / force utilities
// ─────────────────────────────────────────────────────────────

Vec3 magneticDipoleField(Vec3 r, Vec3 m) {
    constexpr float K = PhysicsConstants::MU_0 / (4.f * PhysicsConstants::PI);
    float r2   = r.lengthSq();
    float r_   = std::sqrt(r2);
    if (r_ < 1e-9f) return {};
    Vec3  rhat = r * (1.f / r_);
    float mr   = m.dot(rhat);
    float r3   = r_ * r2;
    return (rhat * (3.f * mr) - m) * (K / r3);
}

Vec3 magneticDipoleForce(Vec3 pos1, Vec3 m1, Vec3 pos2, Vec3 m2) {
    constexpr float H = 1e-5f;
    auto B = [&](Vec3 p) { return magneticDipoleField(p - pos1, m1); };
    float fx = m2.dot(B({pos2.x+H, pos2.y,   pos2.z  }) - B({pos2.x-H, pos2.y,   pos2.z  })) / (2.f * H);
    float fy = m2.dot(B({pos2.x,   pos2.y+H, pos2.z  }) - B({pos2.x,   pos2.y-H, pos2.z  })) / (2.f * H);
    float fz = m2.dot(B({pos2.x,   pos2.y,   pos2.z+H}) - B({pos2.x,   pos2.y,   pos2.z-H})) / (2.f * H);
    return {fx, fy, fz};
}

float axialBField(float z, float radius, float height, float Br) {
    float h2 = height * 0.5f;
    float r2 = radius * radius;
    float zp = z + h2;
    float zm = z - h2;
    return 0.5f * Br * (zp / std::sqrt(r2 + zp*zp) - zm / std::sqrt(r2 + zm*zm));
}

// ─────────────────────────────────────────────────────────────
// SEG roller dynamics
// ─────────────────────────────────────────────────────────────

float seg_roller_torque(const SEGRollerState& r, float B_avg, int numRollers) {
    constexpr float COIL_COUPLING = 0.15f;
    float spacing = PhysicsConstants::TAU / static_cast<float>(numRollers);
    return COIL_COUPLING * B_avg * r.inertia * r.omega * spacing;
}

void seg_roller_rk4(SEGRollerState& r, float dt, float loadTorque) {
    float B_avg = axialBField(0.f, r.radius * 0.08f, 0.05f, PhysicsConstants::Br_DEFAULT);
    B_avg = std::max(0.f, B_avg);
    int n = 12;
    auto tau = [&](float w) {
        SEGRollerState tmp = r;
        tmp.omega = w;
        return seg_roller_torque(tmp, B_avg, n) - loadTorque;
    };
    auto dw = [&](float w) { return tau(w) / (r.inertia > 1e-12f ? r.inertia : 1.f); };
    auto da = [&](float w) { return w; };

    float k1w = dw(r.omega); float k1a = da(r.omega);
    float k2w = dw(r.omega + 0.5f * dt * k1w); float k2a = da(r.omega + 0.5f * dt * k1w);
    float k3w = dw(r.omega + 0.5f * dt * k2w); float k3a = da(r.omega + 0.5f * dt * k2w);
    float k4w = dw(r.omega + dt * k3w); float k4a = da(r.omega + dt * k3w);

    r.omega += dt * (k1w + 2.f*k2w + 2.f*k3w + k4w) / 6.f;
    r.angle += dt * (k1a + 2.f*k2a + 2.f*k3a + k4a) / 6.f;
    r.omega = clampf(r.omega, 0.f, 314.16f);
    r.angle = r.angle - PhysicsConstants::TAU * std::floor(r.angle / PhysicsConstants::TAU);
}

// ─────────────────────────────────────────────────────────────
// Particle dynamics
// ─────────────────────────────────────────────────────────────

void seg_particle_step(SimParticle& p, float omega, float corona, float dt) {
    float rXZ = std::sqrt(p.x*p.x + p.z*p.z);
    float r = std::max(rXZ, 1e-4f);
    float radialX  =  p.x / r;
    float radialZ  =  p.z / r;
    float tangentX = -radialZ;
    float tangentZ =  radialX;
    float vXZ_tan = p.vx * tangentX + p.vz * tangentZ;
    float vXZ_rad = p.vx * radialX  + p.vz * radialZ;
    float R = 3.5f;
    if (std::abs(r - 5.5f) < std::abs(r - R)) R = 5.5f;
    if (std::abs(r - 7.5f) < std::abs(r - R)) R = 7.5f;
    float vTarget = omega * R * 1.2f;
    float aTan = (vTarget - vXZ_tan) * 3.f;
    float aRad = -(r - R) * 26.f - vXZ_rad * 4.f;
    float aY   = -p.y * 9.f - p.vy * 3.f;
    float aXZ_x = tangentX * aTan + radialX * aRad;
    float aXZ_z = tangentZ * aTan + radialZ * aRad;
    float turb1 = std::sin(p.phase * 31.4f) * 0.045f;
    float turb2 = std::cos(p.phase * 17.8f) * 0.032f;
    float turb3 = std::sin(p.phase * 43.2f) * 0.028f;
    aXZ_x += (turb1 + turb2 * radialX) * corona;
    aY    += turb3 * corona;
    aXZ_z += (turb1 * radialZ - turb2) * corona;
    p.vx += aXZ_x * dt; p.vy += aY * dt; p.vz += aXZ_z * dt;
    p.x  += p.vx  * dt; p.y  += p.vy * dt; p.z  += p.vz  * dt;
}

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

// ─────────────────────────────────────────────────────────────
// SEGSimulator
// ─────────────────────────────────────────────────────────────

constexpr int   SEGSimulator::RING_COUNTS[3];
constexpr float SEGSimulator::RING_RADII[3];

SEGSimulator::SEGSimulator() {
    _initRollers();
    lcg_state = static_cast<uint32_t>(std::time(nullptr));
    // Kelvin breakdown: E_BREAKDOWN ~ 3e6 V/m * 0.02 m gap
    _kelvin.vBreak = 3.0e6f * 0.02f;
}

void SEGSimulator::_initRollers() {
    _numRollers = 0;
    for (int ring = 0; ring < 3; ++ring) {
        int   n = RING_COUNTS[ring];
        float R = RING_RADII[ring];
        for (int i = 0; i < n; ++i) {
            SEGRollerState& r = _rollers[_numRollers++];
            r.omega   = 0.f;
            r.angle   = PhysicsConstants::TAU * static_cast<float>(i) / static_cast<float>(n);
            r.radius  = R;
            r.height  = 0.f;
            r.inertia = 0.01f * R;
            r.torque  = 0.f;
        }
    }
    packRollerState();
}

void SEGSimulator::step(float dt, float loadTorque) {
    _ringLoadTorques[0] = _ringLoadTorques[1] = _ringLoadTorques[2] = loadTorque;
    stepWithPerRingTorques(dt);
}

void SEGSimulator::setDrive(float drive) {
    _drive = clampf(drive, 0.f, 1.f);
    _heron.drive = _drive;
    _kelvin.drive = _drive;
    _solar.ledPower = 0.3f + 0.7f * _drive;
}

void SEGSimulator::_stepSegRollers(float dt) {
    for (int i = 0; i < _numRollers; ++i) {
        int ring = rollerIndexToRing(i);
        seg_roller_rk4(_rollers[i], dt, _ringLoadTorques[ring]);
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

void SEGSimulator::_stepSolar(float dt) {
    SolarState& s = _solar;
    float ledPower = s.ledPower;
    float gain = s.transmittance * ledPower * s.opticalEff;
    float drainW = ledPower * s.ledWallPlug;
    s.batteryCharge = clampf(s.batteryCharge + (gain - drainW) * dt, 0.f, 1.f);
}

void SEGSimulator::stepWithPerRingTorques(float dt) {
    switch (_mode) {
        case SIM_MODE_SEG:
            _stepSegRollers(dt);
            break;
        case SIM_MODE_HERON:
            _stepHeron(dt);
            break;
        case SIM_MODE_KELVIN:
            _stepKelvin(dt);
            break;
        case SIM_MODE_SOLAR:
            _stepSolar(dt);
            break;
        default:
            break;
    }
    _time += dt;
    packRollerState();
}

void SEGSimulator::setRingLoadTorque(int ring, float torque) {
    if (ring >= 0 && ring < 3) _ringLoadTorques[ring] = torque;
}

void SEGSimulator::setRingLoadTorques(float tInner, float tMiddle, float tOuter) {
    _ringLoadTorques[0] = tInner;
    _ringLoadTorques[1] = tMiddle;
    _ringLoadTorques[2] = tOuter;
}

void SEGSimulator::setMode(int mode) {
    if (mode >= 0 && mode <= 3) _mode = mode;
}

int SEGSimulator::getMode() const { return _mode; }

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
        }
    }
}

Vec3 SEGSimulator::sampleBField(Vec3 worldPos) const {
    Vec3 total{};
    for (int i = 0; i < _numRollers; ++i) {
        Vec3 rPos = rollerWorldPos(i);
        Vec3 r = worldPos - rPos;
        Vec3 m{0.f, _Br * 1e-4f, 0.f};
        total += magneticDipoleField(r, m);
    }
    return total;
}

Vec3 SEGSimulator::rollerWorldPos(int i) const {
    const SEGRollerState& r = _rollers[i];
    return { std::cos(r.angle) * r.radius, r.height, std::sin(r.angle) * r.radius };
}

float SEGSimulator::estimatePower(float loadTorque) const {
    if (_mode == SIM_MODE_HERON) {
        // Hydraulic power proxy ρ g Q H
        float Q = _heron.flowLmin / 60000.f;
        return 1000.f * PhysicsConstants::G * Q * _heron.head;
    }
    if (_mode == SIM_MODE_KELVIN) {
        // Capacitive energy dump rate proxy
        return 0.5f * 40.1e-12f * _kelvin.voltage * _kelvin.voltage / std::max(_kelvin.sparkDur, 0.01f)
               * (_kelvin.sparkTimer > 0.f ? 1.f : 0.1f);
    }
    if (_mode == SIM_MODE_SOLAR) {
        return _solar.ledPower * 12.f * _solar.batteryCharge; // scene Watts
    }
    if (_numRollers == 0) return 0.f;
    return loadTorque * _rollers[0].omega * static_cast<float>(_numRollers) / 3.f;
}

float SEGSimulator::magneticEnergyDensity() const {
    float B = axialBField(0.f, 0.05f, 0.025f, _Br);
    return (B * B) / (2.f * PhysicsConstants::MU_0);
}

float SEGSimulator::getEnergyLevel() const {
    switch (_mode) {
        case SIM_MODE_HERON: {
            float vRef = std::sqrt(2.f * PhysicsConstants::G * _heron.headMax) * _heron.dischargeCoeff;
            return clampf(_heron.vExit / std::max(vRef, 0.5f), 0.f, 1.f);
        }
        case SIM_MODE_KELVIN: return _kelvin.voltageN;
        case SIM_MODE_SOLAR:  return _solar.batteryCharge;
        default:
            return clampf(_rollers[0].omega / 50.f, 0.f, 1.f);
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

void SEGSimulator::packRollerState() {
    for (int i = 0; i < _numRollers; ++i) {
        int b = i * ROLLER_EXPORT_STRIDE;
        _rollerExport[b + 0] = _rollers[i].angle;
        _rollerExport[b + 1] = _rollers[i].omega;
        _rollerExport[b + 2] = _rollers[i].radius;
        _rollerExport[b + 3] = _rollers[i].height;
    }
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

const char* SEGSimulator::version() {
    return "sim_core 1.1.0";
}

// ─────────────────────────────────────────────────────────────
// Emscripten / Embind
// ─────────────────────────────────────────────────────────────
#ifdef __EMSCRIPTEN__

EMSCRIPTEN_BINDINGS(sim_core) {
    value_object<Vec3>("Vec3")
        .field("x", &Vec3::x)
        .field("y", &Vec3::y)
        .field("z", &Vec3::z);

    value_object<SimParticle>("SimParticle")
        .field("x", &SimParticle::x)
        .field("y", &SimParticle::y)
        .field("z", &SimParticle::z)
        .field("phase", &SimParticle::phase)
        .field("vx", &SimParticle::vx)
        .field("vy", &SimParticle::vy)
        .field("vz", &SimParticle::vz)
        .field("aux", &SimParticle::aux);

    function("magneticDipoleField", &magneticDipoleField);
    function("magneticDipoleForce", &magneticDipoleForce);
    function("axialBField", &axialBField);
    function("sim_core_version", optional_override([]() -> std::string {
        return std::string(sim_core_version());
    }));

    class_<SEGSimulator>("SEGSimulator")
        .constructor()
        .function("step", &SEGSimulator::step)
        .function("seedParticles", &SEGSimulator::seedParticles)
        .function("stepParticles", &SEGSimulator::stepParticles)
        .function("getOmega", &SEGSimulator::getOmega)
        .function("getRPM", &SEGSimulator::getRPM)
        .function("getOmegaF64", &SEGSimulator::getOmegaF64)
        .function("getRPMF64", &SEGSimulator::getRPMF64)
        .function("getAngle", &SEGSimulator::getAngle)
        .function("numRollers", &SEGSimulator::numRollers)
        .function("numParticles", &SEGSimulator::numParticles)
        .function("getTime", &SEGSimulator::getTime)
        .function("sampleBField", &SEGSimulator::sampleBField)
        .function("rollerWorldPos", &SEGSimulator::rollerWorldPos)
        .function("estimatePower", &SEGSimulator::estimatePower)
        .function("magneticEnergyDensity", &SEGSimulator::magneticEnergyDensity)
        .function("getParticle", &SEGSimulator::getParticle)
        .function("getParticles", &SEGSimulator::getParticles)
        .function("setRingLoadTorque", &SEGSimulator::setRingLoadTorque)
        .function("setRingLoadTorques", &SEGSimulator::setRingLoadTorques)
        .function("stepWithPerRingTorques", &SEGSimulator::stepWithPerRingTorques)
        .function("setMode", &SEGSimulator::setMode)
        .function("getMode", &SEGSimulator::getMode)
        .function("setDrive", &SEGSimulator::setDrive)
        .function("getDrive", &SEGSimulator::getDrive)
        .function("getHeronHead", &SEGSimulator::getHeronHead)
        .function("getHeronVExit", &SEGSimulator::getHeronVExit)
        .function("getHeronFlowLmin", &SEGSimulator::getHeronFlowLmin)
        .function("getHeronPressureKPa", &SEGSimulator::getHeronPressureKPa)
        .function("getKelvinVoltage", &SEGSimulator::getKelvinVoltage)
        .function("getKelvinVoltageN", &SEGSimulator::getKelvinVoltageN)
        .function("getKelvinE", &SEGSimulator::getKelvinE)
        .function("getKelvinSparkTimer", &SEGSimulator::getKelvinSparkTimer)
        .function("getSolarBattery", &SEGSimulator::getSolarBattery)
        .function("getEnergyLevel", &SEGSimulator::getEnergyLevel)
        .function("getParticleBufferPtr", optional_override([](SEGSimulator& self) -> double {
            return static_cast<double>(self.getParticleBufferPtr());
        }))
        .function("getParticleFloatCount", &SEGSimulator::getParticleFloatCount)
        .function("getRollerStatePtr", optional_override([](SEGSimulator& self) -> double {
            return static_cast<double>(self.getRollerStatePtr());
        }))
        .function("getRollerStateFloatCount", &SEGSimulator::getRollerStateFloatCount)
        .function("packRollerState", &SEGSimulator::packRollerState)
        .class_function("version", optional_override([]() -> std::string {
            return std::string(SEGSimulator::version());
        }));
}

#endif // __EMSCRIPTEN__

// ─────────────────────────────────────────────────────────────
// Standalone smoke-test
// ─────────────────────────────────────────────────────────────
#ifdef SIM_CORE_STANDALONE
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include "telemetry_export.h"

static float clamp01f(float v) {
    return v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
}

int export_seg_csv(
    const char* path, float durationSec, float sampleHz,
    float drive, float loadTorque, float fieldStrength, float loadOhm)
{
    SEGSimulator sim;
    sim.setMode(SIM_MODE_SEG);
    sim.setDrive(drive);
    sim.seedParticles(1000);

    FILE* f = std::fopen(path, "w");
    if (!f) return 1;

    std::fprintf(f, "%s\n", TELEMETRY_CSV_HEADER);

    const float physicsDt = 1.f / 60.f;
    const float sampleDt = 1.f / sampleHz;
    float simTime = 0.f;
    float accum = 0.f;
    int frameId = 0;
    int steps = 0;
    const int maxSteps = static_cast<int>(durationSec * 60.f) + 2;

    while (simTime < durationSec && steps < maxSteps) {
        sim.step(physicsDt, loadTorque);
        sim.stepParticles(physicsDt);
        simTime += physicsDt;
        accum += physicsDt;
        steps++;

        while (accum >= sampleDt && simTime <= durationSec + 1e-3f) {
            accum -= sampleDt;
            frameId++;
            const float tSample = simTime - accum;
            const float omega = sim.getOmega();
            const float segOmega = clamp01f(omega / 50.f);
            float rotationSpeed = segOmega * 100.f;
            if (rotationSpeed > 120.f) rotationSpeed = 120.f;
            const float corona = clamp01f((segOmega - 0.6f) / 0.4f);
            const float rpmInner = rotationSpeed * 30.f;
            const float voltage = rotationSpeed * fieldStrength * 2.5f;
            const float current = loadOhm > 0.f ? voltage / loadOhm : 0.f;
            const float power = sim.estimatePower(loadTorque);
            const float fieldSim = fieldStrength * (1.f + rotationSpeed / 200.f) * TELEMETRY_B_SURFACE_T;
            const float energyD = sim.magneticEnergyDensity();
            const float temp = 25.f + rotationSpeed * 0.3f + corona * 12.f;
            const float eff = drive > 0.f ? 85.f + (rotationSpeed / 100.f) * 10.f : 0.f;

            std::fprintf(f,
                "%.6f,%d,seg,seg,operational,%.2f,%.6f,%.6f,"
                "%.4f,%.6f,%.4f,%.6f,%.6e,"
                "%.4f,%d,%.2f,%.2f,0,%.1f\n",
                tSample, frameId,
                rpmInner, segOmega, corona,
                voltage, current, power, fieldSim, energyD,
                drive, static_cast<int>(fieldStrength * 100.f), temp, eff, loadOhm);
        }
    }

    std::fclose(f);
    return 0;
}

int main(int argc, char** argv) {
    // --export-csv <seconds> [output.csv] [sample_hz]
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--export-csv") == 0 && i + 1 < argc) {
            const float duration = std::atof(argv[i + 1]);
            const char* out = (i + 2 < argc && argv[i + 2][0] != '-') ? argv[i + 2] : "build/seg_telemetry.csv";
            const float hz = (i + 3 < argc) ? std::atof(argv[i + 3]) : 10.f;
            const int rc = export_seg_csv(out, duration, hz, 0.5f, 0.01f, 0.5f, 100.f);
            if (rc != 0) {
                std::fprintf(stderr, "Failed to write %s\n", out);
                return rc;
            }
            std::printf("Exported %g s SEG telemetry → %s @ %.1f Hz\n", duration, out, hz);
            return 0;
        }
    }

    printf("sim_core version: %s\n", sim_core_version());

    SEGSimulator sim;
    printf("Rollers: %d\n", sim.numRollers());

    // ── SEG path ──
    sim.setMode(SIM_MODE_SEG);
    sim.seedParticles(1000);
    float dt = 1.f / 60.f;
    for (int i = 0; i < 100; ++i) {
        sim.step(dt, 0.01f);
        sim.stepParticles(dt);
    }
    printf("SEG Omega after 100 steps: %.4f rad/s (%.1f RPM)\n",
           sim.getOmega(), sim.getRPM());
    printf("Magnetic energy density: %.4e J/m^3\n", sim.magneticEnergyDensity());
    printf("Estimated power (load 0.01 Nm): %.4f W\n", sim.estimatePower(0.01f));

    // ── Heron path ──
    sim.setMode(SIM_MODE_HERON);
    sim.setDrive(0.8f);
    for (int i = 0; i < 200; ++i) sim.step(dt, 0.f);
    printf("Heron head=%.3f m  vExit=%.3f m/s  Q=%.2f L/min  P=%.2f kPa\n",
           sim.getHeronHead(), sim.getHeronVExit(),
           sim.getHeronFlowLmin(), sim.getHeronPressureKPa());
    if (sim.getHeronHead() <= 0.f && sim.getHeronVExit() <= 0.f) {
        printf("FAIL: Heron state did not advance\n");
        return 1;
    }

    // ── Kelvin path ──
    sim.setMode(SIM_MODE_KELVIN);
    sim.setDrive(1.f);
    for (int i = 0; i < 400; ++i) sim.step(dt, 0.f);
    printf("Kelvin V=%.1f V  Vn=%.3f  E=%.2f  sparkT=%.3f\n",
           sim.getKelvinVoltage(), sim.getKelvinVoltageN(),
           sim.getKelvinE(), sim.getKelvinSparkTimer());
    if (sim.getKelvinVoltage() <= 0.f && sim.getKelvinVoltageN() <= 0.f) {
        printf("FAIL: Kelvin state did not advance\n");
        return 1;
    }

    // ── Solar path ──
    sim.setMode(SIM_MODE_SOLAR);
    sim.setDrive(1.f);
    float bat0 = sim.getSolarBattery();
    for (int i = 0; i < 300; ++i) sim.step(dt, 0.f);
    printf("Solar battery SOC: %.3f -> %.3f\n", bat0, sim.getSolarBattery());
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Solar energy level out of range\n");
        return 1;
    }

    // Zero-copy packing smoke
    sim.setMode(SIM_MODE_SEG);
    sim.packRollerState();
    printf("Zero-copy: particlePtr=%zu floats=%d  rollerPtr=%zu floats=%d\n",
           (size_t)sim.getParticleBufferPtr(), sim.getParticleFloatCount(),
           (size_t)sim.getRollerStatePtr(), sim.getRollerStateFloatCount());
    if (sim.getRollerStateFloatCount() != 66 * 4) {
        printf("FAIL: unexpected roller export size\n");
        return 1;
    }

    printf("All mode smoke tests OK\n");
    return 0;
}
#endif // SIM_CORE_STANDALONE

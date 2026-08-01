// =============================================================
// seg_plant.cpp  –  SEG magnetic-field utilities + roller RK4 dynamics
// (pure extraction from sim_core.cpp — no logic changes)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

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

float estimateHalbachFieldT(float gapM, float remanenceT) {
    float Br = remanenceT > 0.f ? remanenceT : PhysicsConstants::Br_DEFAULT;
    constexpr float R = 0.028f;
    constexpr float FOUR_PI = 4.f * PhysicsConstants::PI;
    float B0 = Br * PhysicsConstants::MU_0 / FOUR_PI
             * (2.f * PhysicsConstants::PI * R) / std::max(gapM, 0.002f);
    return std::min(1.2f, B0 * 8.f);
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
// SEG particle dynamics
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

// ─────────────────────────────────────────────────────────────
// SEGSimulator — SEG-specific methods
// ─────────────────────────────────────────────────────────────

constexpr int   SEGSimulator::RING_COUNTS[3];
constexpr float SEGSimulator::RING_RADII[3];

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

void SEGSimulator::_stepSegRollers(float dt) {
    for (int i = 0; i < _numRollers; ++i) {
        int ring = rollerIndexToRing(i);
        seg_roller_rk4(_rollers[i], dt, _ringLoadTorques[ring]);
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

float SEGSimulator::magneticEnergyDensity() const {
    float B = axialBField(0.f, 0.05f, 0.025f, _Br);
    return (B * B) / (2.f * PhysicsConstants::MU_0);
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

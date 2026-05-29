// =============================================================
// sim_core.cpp  –  SEG simulation core implementation
// =============================================================
//
// Compile for native testing:
//   g++ -std=c++17 -O2 -o sim_core_test sim_core.cpp -DSIM_CORE_STANDALONE
//
// Compile to WASM with Emscripten (see cpp/Makefile):
//   emcc -O3 --bind -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=SimCore \
//        -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web \
//        sim_core.cpp -o ../build/sim_core.js
// =============================================================

#include "sim_core.h"

#ifdef __EMSCRIPTEN__
#  include <emscripten/bind.h>
using namespace emscripten;
#endif

#include <cstdlib>   // rand, srand
#include <ctime>     // time

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────
namespace {

inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// Simple LCG pseudo-random float in [0, 1).
// Note: this global state is intentionally module-scoped. Emscripten compiles
// to a single-threaded WASM module by default (no pthreads), so concurrent
// access is not possible in the browser runtime. If pthreads support is ever
// enabled, move this to per-instance state or use thread-local storage.
static uint32_t lcg_state = 0x12345678u;
inline float lcg_rand() {
    lcg_state = lcg_state * 1664525u + 1013904223u;
    return static_cast<float>(lcg_state >> 8) / static_cast<float>(1u << 24);
}

// Hash-based deterministic random – mirrors compute.wgsl hash1 / rnd
inline float hash1(float n) {
    float v = std::sin(n * 78.233f + 12.9898f) * 43758.5453f;
    return v - std::floor(v);
}
inline float rnd(uint32_t idx, float salt, float simClock = 0.f) {
    return hash1(static_cast<float>(idx) * 0.1031f + salt * 1.7f + simClock * 0.37f);
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
    float mr   = m.dot(rhat);         // m · r̂
    float r3   = r_ * r2;            // r³

    // B = K * [3(m·r̂)r̂ − m] / r³
    return (rhat * (3.f * mr) - m) * (K / r3);
}

Vec3 magneticDipoleForce(Vec3 pos1, Vec3 m1, Vec3 pos2, Vec3 m2) {
    // F = ∇(m2 · B1) evaluated by 6-point central finite difference
    constexpr float H = 1e-5f;
    auto B = [&](Vec3 p) { return magneticDipoleField(p - pos1, m1); };

    float fx = m2.dot(B({pos2.x+H, pos2.y,   pos2.z  })
                    - B({pos2.x-H, pos2.y,   pos2.z  })) / (2.f * H);
    float fy = m2.dot(B({pos2.x,   pos2.y+H, pos2.z  })
                    - B({pos2.x,   pos2.y-H, pos2.z  })) / (2.f * H);
    float fz = m2.dot(B({pos2.x,   pos2.y,   pos2.z+H})
                    - B({pos2.x,   pos2.y,   pos2.z-H})) / (2.f * H);
    return {fx, fy, fz};
}

float axialBField(float z, float radius, float height, float Br) {
    // Exact formula for on-axis B of a uniformly-magnetised cylinder:
    //   Bz = (Br/2) * [ (h/2 + z)/√(r²+(h/2+z)²) − (−h/2+z)/√(r²+(−h/2+z)²) ]
    float h2 = height * 0.5f;
    float r2 = radius * radius;
    float zp = z + h2;
    float zm = z - h2;
    return 0.5f * Br * (zp / std::sqrt(r2 + zp*zp)
                      - zm / std::sqrt(r2 + zm*zm));
}

// ─────────────────────────────────────────────────────────────
// SEG roller dynamics
// ─────────────────────────────────────────────────────────────

float seg_roller_torque(const SEGRollerState& r, float B_avg, int numRollers) {
    // Simplified Lorentz torque model: τ_mag = k · B · I · ω
    // where k = 2π / numRollers (spacing factor) and I ∝ r.inertia.
    // COIL_COUPLING (0.15) is a scene-scaled lumped electromagnetic coupling
    // coefficient that relates B-field strength, roller inertia, and angular
    // velocity to the net drive torque. Derived empirically to give the
    // characteristic SEG self-acceleration at Br ≈ 1.48 T (N52 NdFeB).
    // This gives a self-amplifying torque that grows with B and ω,
    // providing the classic SEG self-sustaining behaviour at high field.
    constexpr float COIL_COUPLING = 0.15f; // scene-scaled electromagnetic coupling
    float spacing = PhysicsConstants::TAU / static_cast<float>(numRollers);
    return COIL_COUPLING * B_avg * r.inertia * r.omega * spacing;
}

void seg_roller_rk4(SEGRollerState& r, float dt, float loadTorque) {
    // State: [omega, angle].  Derivative: domega/dt = (driveTorque − loadTorque) / I
    // dangle/dt = omega.
    // B_avg: sample the on-axis field of a nominal NdFeB cylinder:
    //   radius = ring_radius * 0.08  (roller outer radius ≈ 8% of ring radius)
    //   height = 0.05 m              (roller axial half-height)
    float B_avg = axialBField(0.f, r.radius * 0.08f, 0.05f, PhysicsConstants::Br_DEFAULT);
    B_avg = std::max(0.f, B_avg);

    // Simple single-ring approximation (12 rollers on inner ring)
    int   n   = 12;
    auto  tau = [&](float w) {
        SEGRollerState tmp = r;
        tmp.omega = w;
        return seg_roller_torque(tmp, B_avg, n) - loadTorque;
    };
    auto  dw  = [&](float w) { return tau(w) / (r.inertia > 1e-12f ? r.inertia : 1.f); };
    auto  da  = [&](float w) { return w; };

    // RK4 on [omega, angle]
    float k1w = dw(r.omega);
    float k1a = da(r.omega);

    float k2w = dw(r.omega + 0.5f * dt * k1w);
    float k2a = da(r.omega + 0.5f * dt * k1w);

    float k3w = dw(r.omega + 0.5f * dt * k2w);
    float k3a = da(r.omega + 0.5f * dt * k2w);

    float k4w = dw(r.omega + dt * k3w);
    float k4a = da(r.omega + dt * k3w);

    r.omega += dt * (k1w + 2.f*k2w + 2.f*k3w + k4w) / 6.f;
    r.angle += dt * (k1a + 2.f*k2a + 2.f*k3a + k4a) / 6.f;

    // Clamp omega to a sensible physical range (0 – ~3000 rpm → ~314 rad/s)
    r.omega = clampf(r.omega, 0.f, 314.16f);
    // Keep angle in [0, 2π)
    r.angle = r.angle - PhysicsConstants::TAU * std::floor(r.angle / PhysicsConstants::TAU);
}

// ─────────────────────────────────────────────────────────────
// Particle dynamics (SEG mode – mirrors compute.wgsl mode-0)
// ─────────────────────────────────────────────────────────────

void seg_particle_step(SimParticle& p, float omega, float corona, float dt) {
    // Determine ring radius from particle index (approximate: use current r)
    float rXZ = std::sqrt(p.x*p.x + p.z*p.z);
    float r = std::max(rXZ, 1e-4f);

    float radialX  =  p.x / r;
    float radialZ  =  p.z / r;
    float tangentX = -radialZ;   // CCW unit tangent
    float tangentZ =  radialX;

    float vXZ_tan = p.vx * tangentX + p.vz * tangentZ;
    float vXZ_rad = p.vx * radialX  + p.vz * radialZ;

    // Snap ring radius to nearest of {3.5, 5.5, 7.5}
    float R = 3.5f;
    if (std::abs(r - 5.5f) < std::abs(r - R)) R = 5.5f;
    if (std::abs(r - 7.5f) < std::abs(r - R)) R = 7.5f;

    float vTarget = omega * R * 1.2f;
    float aTan    = (vTarget - vXZ_tan) * 3.f;
    float aRad    = -(r - R) * 26.f - vXZ_rad * 4.f;
    float aY      = -p.y * 9.f - p.vy * 3.f;

    float aXZ_x = tangentX * aTan + radialX * aRad;
    float aXZ_z = tangentZ * aTan + radialZ * aRad;

    // Turbulence term (simplified; simClock = 0 for CPU version)
    float turb1 = std::sin(p.phase * 31.4f) * 0.045f;
    float turb2 = std::cos(p.phase * 17.8f) * 0.032f;
    float turb3 = std::sin(p.phase * 43.2f) * 0.028f;

    aXZ_x += (turb1 + turb2 * radialX) * corona;
    aY    += turb3 * corona;
    aXZ_z += (turb1 * radialZ - turb2) * corona;

    // Semi-implicit Euler (matches WGSL integrator)
    p.vx += aXZ_x * dt;
    p.vy += aY    * dt;
    p.vz += aXZ_z * dt;
    p.x  += p.vx  * dt;
    p.y  += p.vy  * dt;
    p.z  += p.vz  * dt;
}

// ─────────────────────────────────────────────────────────────
// SEGSimulator implementation
// ─────────────────────────────────────────────────────────────

constexpr int   SEGSimulator::RING_COUNTS[3];
constexpr float SEGSimulator::RING_RADII[3];

SEGSimulator::SEGSimulator() {
    _initRollers();
    lcg_state = static_cast<uint32_t>(std::time(nullptr));
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
            // Inertia scales with ring radius (mass ∝ R)
            r.inertia = 0.01f * R;
            r.torque  = 0.f;
        }
    }
}

void SEGSimulator::step(float dt, float loadTorque) {
    float B_avg = axialBField(0.f, 0.05f, 0.025f, _Br);
    B_avg = std::max(0.f, B_avg);

    for (int i = 0; i < _numRollers; ++i) {
        seg_roller_rk4(_rollers[i], dt, loadTorque);
    }
    _time += dt;
}

void SEGSimulator::seedParticles(int count) {
    _numParticles = (count < 0) ? 0 :
                    (count > MAX_PARTICLES) ? MAX_PARTICLES : count;
    for (int i = 0; i < _numParticles; ++i) {
        uint32_t idx = static_cast<uint32_t>(i);
        // Assign to a ring
        int   ring = i % 3;
        float R    = RING_RADII[ring];
        float a    = rnd(idx, 1.f) * PhysicsConstants::TAU;
        float vy0  = (rnd(idx, 2.f) - 0.5f) * 1.6f;
        float vT   = _rollers[0].omega * R * 1.2f;

        SimParticle& p = _particles[i];
        p.x     = std::cos(a) * R;
        p.y     = vy0;
        p.z     = std::sin(a) * R;
        p.phase = rnd(idx, 3.f);
        p.vx    = -std::sin(a) * vT;
        p.vy    = 0.f;
        p.vz    =  std::cos(a) * vT;
        p.aux   = 0.f;
    }
}

void SEGSimulator::stepParticles(float dt) {
    float omega  = (_numRollers > 0) ? _rollers[0].omega : 0.f;
    float corona = 0.5f; // default plasma intensity
    for (int i = 0; i < _numParticles; ++i) {
        seg_particle_step(_particles[i], omega, corona, dt);

        // Recycle out-of-bounds particles (mirrors compute.wgsl)
        SimParticle& p = _particles[i];
        float rXZ = std::sqrt(p.x*p.x + p.z*p.z);
        if (rXZ < 1.f || rXZ > 11.f || std::abs(p.y) > 5.f) {
            // Re-seed this particle
            uint32_t idx = static_cast<uint32_t>(i);
            int   ring = i % 3;
            float R    = RING_RADII[ring];
            float a    = rnd(idx, _time + 1.f) * PhysicsConstants::TAU;
            float vT   = omega * R * 1.2f;
            p.x  = std::cos(a) * R;
            p.y  = (rnd(idx, _time + 2.f) - 0.5f) * 1.6f;
            p.z  = std::sin(a) * R;
            p.vx = -std::sin(a) * vT;
            p.vy = 0.f;
            p.vz =  std::cos(a) * vT;
        }
    }
}

Vec3 SEGSimulator::sampleBField(Vec3 worldPos) const {
    Vec3 total{};
    for (int i = 0; i < _numRollers; ++i) {
        Vec3 rPos = rollerWorldPos(i);
        Vec3 r    = worldPos - rPos;
        // Dipole moment aligned with the toroidal axis (y-axis)
        Vec3 m{0.f, _Br * 1e-4f, 0.f}; // approximate moment
        total += magneticDipoleField(r, m);
    }
    return total;
}

Vec3 SEGSimulator::rollerWorldPos(int i) const {
    const SEGRollerState& r = _rollers[i];
    return { std::cos(r.angle) * r.radius,
             r.height,
             std::sin(r.angle) * r.radius };
}

float SEGSimulator::estimatePower(float loadTorque) const {
    if (_numRollers == 0) return 0.f;
    // P = τ_load × ω  (summed over all rollers, divided by ring count
    //   since they share the angular velocity in this simplified model)
    float omega = _rollers[0].omega;
    return loadTorque * omega * static_cast<float>(_numRollers) / 3.f;
}

float SEGSimulator::magneticEnergyDensity() const {
    // u = B²/(2μ₀)  at the average ring radius (r = 5.5 m scene units)
    float B = axialBField(0.f, 0.05f, 0.025f, _Br);
    return (B * B) / (2.f * PhysicsConstants::MU_0);
}

SimParticle SEGSimulator::getParticle(int i) const {
    if (i < 0 || i >= _numParticles) return {};
    return _particles[i];
}

const char* SEGSimulator::version() {
    return "sim_core 1.0.0";
}

// ─────────────────────────────────────────────────────────────
// Emscripten / Embind bindings
// ─────────────────────────────────────────────────────────────
#ifdef __EMSCRIPTEN__

EMSCRIPTEN_BINDINGS(sim_core) {
    // ── Vec3 ──────────────────────────────────────────────────
    value_object<Vec3>("Vec3")
        .field("x", &Vec3::x)
        .field("y", &Vec3::y)
        .field("z", &Vec3::z);

    // ── SimParticle ───────────────────────────────────────────
    value_object<SimParticle>("SimParticle")
        .field("x",     &SimParticle::x)
        .field("y",     &SimParticle::y)
        .field("z",     &SimParticle::z)
        .field("phase", &SimParticle::phase)
        .field("vx",    &SimParticle::vx)
        .field("vy",    &SimParticle::vy)
        .field("vz",    &SimParticle::vz)
        .field("aux",   &SimParticle::aux);

    // ── Free functions ────────────────────────────────────────
    function("magneticDipoleField", &magneticDipoleField);
    function("magneticDipoleForce", &magneticDipoleForce);
    function("axialBField",         &axialBField);
    function("sim_core_version",    &sim_core_version);

    // ── SEGSimulator class ────────────────────────────────────
    class_<SEGSimulator>("SEGSimulator")
        .constructor()
        .function("step",                  &SEGSimulator::step)
        .function("seedParticles",         &SEGSimulator::seedParticles)
        .function("stepParticles",         &SEGSimulator::stepParticles)
        .function("getOmega",              &SEGSimulator::getOmega)
        .function("getRPM",                &SEGSimulator::getRPM)
        .function("getAngle",              &SEGSimulator::getAngle)
        .function("numRollers",            &SEGSimulator::numRollers)
        .function("numParticles",          &SEGSimulator::numParticles)
        .function("sampleBField",          &SEGSimulator::sampleBField)
        .function("rollerWorldPos",        &SEGSimulator::rollerWorldPos)
        .function("estimatePower",         &SEGSimulator::estimatePower)
        .function("magneticEnergyDensity", &SEGSimulator::magneticEnergyDensity)
        .function("getParticle",           &SEGSimulator::getParticle)
        .class_function("version",         &SEGSimulator::version);
}

#endif // __EMSCRIPTEN__

// ─────────────────────────────────────────────────────────────
// Standalone smoke-test  (g++ -DSIM_CORE_STANDALONE sim_core.cpp)
// ─────────────────────────────────────────────────────────────
#ifdef SIM_CORE_STANDALONE
#include <cstdio>
int main() {
    printf("sim_core version: %s\n", sim_core_version());

    SEGSimulator sim;
    printf("Rollers: %d\n", sim.numRollers());

    // Seed particles and run 100 physics steps
    sim.seedParticles(1000);
    float dt = 1.f / 60.f;
    for (int i = 0; i < 100; ++i) {
        sim.step(dt, 0.01f);
        sim.stepParticles(dt);
    }

    printf("Omega after 100 steps: %.4f rad/s (%.1f RPM)\n",
           sim.getOmega(), sim.getRPM());
    printf("Magnetic energy density: %.4e J/m^3\n",
           sim.magneticEnergyDensity());
    printf("Estimated power (load 0.01 Nm): %.4f W\n",
           sim.estimatePower(0.01f));

    Vec3  samplePos{3.5f, 0.f, 0.f};
    Vec3  B = sim.sampleBField(samplePos);
    printf("B-field at (3.5, 0, 0): (%.4e, %.4e, %.4e) T\n", B.x, B.y, B.z);

    return 0;
}
#endif // SIM_CORE_STANDALONE

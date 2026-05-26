#pragma once
// =============================================================
// sim_core.h  –  SEG simulation core  (C++17, WASM-compatible)
// =============================================================
//
// Provides:
//  • Vec3 / math helpers
//  • SimParticle layout that mirrors the GPU compute shader
//  • SEGRollerState + RK4 integrator
//  • Magnetic dipole field / force utilities
//  • SEGSimulator high-level class
//  • Embind bindings (compiled only under __EMSCRIPTEN__)
//
// Physics units follow the project convention (scene units ≈ SI
// with lengths in metres, time in seconds, angles in radians).
// =============================================================

#include <cmath>
#include <cstdint>
#include <cstring>

// ─────────────────────────────────────────────────────────────
// Vec3  (simple 3-component float vector)
// ─────────────────────────────────────────────────────────────
struct Vec3 {
    float x{0.f}, y{0.f}, z{0.f};

    Vec3() = default;
    Vec3(float x_, float y_, float z_) : x(x_), y(y_), z(z_) {}

    Vec3  operator+(const Vec3& o) const { return {x+o.x, y+o.y, z+o.z}; }
    Vec3  operator-(const Vec3& o) const { return {x-o.x, y-o.y, z-o.z}; }
    Vec3  operator*(float s)       const { return {x*s,   y*s,   z*s  }; }
    Vec3  operator/(float s)       const { return {x/s,   y/s,   z/s  }; }
    Vec3& operator+=(const Vec3& o) { x+=o.x; y+=o.y; z+=o.z; return *this; }
    Vec3& operator*=(float s)       { x*=s;   y*=s;   z*=s;   return *this; }

    float dot(const Vec3& o)   const { return x*o.x + y*o.y + z*o.z; }
    Vec3  cross(const Vec3& o) const {
        return { y*o.z - z*o.y,
                 z*o.x - x*o.z,
                 x*o.y - y*o.x };
    }
    float lengthSq() const { return x*x + y*y + z*z; }
    float length()   const { return std::sqrt(lengthSq()); }
    Vec3  normalized() const {
        float l = length();
        return l > 1e-12f ? *this * (1.f / l) : Vec3{};
    }
};

inline Vec3 operator*(float s, const Vec3& v) { return v * s; }

// ─────────────────────────────────────────────────────────────
// SimParticle  (32 bytes, matches compute.wgsl Particle struct)
// ─────────────────────────────────────────────────────────────
struct SimParticle {
    float x, y, z;    // world position
    float phase;       // per-particle random seed kept across frames
    float vx, vy, vz; // velocity
    float aux;         // mode scalar (Kelvin: charge; Solar: reflected flag)
};

// ─────────────────────────────────────────────────────────────
// SEGRollerState
// ─────────────────────────────────────────────────────────────
struct SEGRollerState {
    float omega;    // angular velocity (rad s⁻¹)
    float angle;    // current azimuthal angle (rad)
    float radius;   // ring radius (scene units / m)
    float height;   // equatorial y-offset (scene units)
    float torque;   // applied coil drive torque (scene-scaled N·m)
    float inertia;  // moment of inertia (kg m², scene-scaled)
};

// ─────────────────────────────────────────────────────────────
// Physics constants (CODATA 2018 / project conventions)
//
// All constants are stored as single-precision float to match the GPU shader
// uniform layout and allow direct memcpy to WebGPU buffers. The rounding error
// relative to double-precision values is < 1 ULP for the magnitudes used here
// (|Br| ≈ 1.48 T, |μ₀| ≈ 1.26e-6 H/m), which is well below the ±5–10%
// uncertainty already present in the dipole-field approximation.
// ─────────────────────────────────────────────────────────────
struct PhysicsConstants {
    static constexpr float MU_0       = 1.2566370614e-7f; // H m⁻¹
    static constexpr float EPSILON_0  = 8.854187817e-12f; // F m⁻¹
    static constexpr float G          = 9.80665f;          // m s⁻²
    static constexpr float PI         = 3.14159265359f;
    static constexpr float TAU        = 6.28318530718f;
    // NdFeB N52 defaults (matches fallback-physics.ts)
    static constexpr float Br_DEFAULT = 1.48f;             // T – remanence
    static constexpr float MU_R       = 1.05f;             // relative permeability
};

// ─────────────────────────────────────────────────────────────
// Free functions
// ─────────────────────────────────────────────────────────────

/// Magnetic dipole field B at displacement r from a dipole with moment m.
/// Uses the far-field formula: B = (μ₀/4π)[3(m·r̂)r̂ − m] / r³
Vec3  magneticDipoleField(Vec3 r, Vec3 m);

/// Force on dipole m2 at pos2 in the gradient field of dipole m1 at pos1.
/// F = ∇(m2 · B1(pos2))  – computed via finite differences.
Vec3  magneticDipoleForce(Vec3 pos1, Vec3 m1, Vec3 pos2, Vec3 m2);

/// On-axis B-field (axial component) of a uniformly-magnetised cylinder.
/// z      : axial distance from magnet centre (m)
/// radius : magnet radius (m)
/// height : magnet half-height (m)
/// Br     : remanence (T)
float axialBField(float z, float radius, float height, float Br);

/// Compute the net tangential magnetic torque on a SEG roller orbiting at
/// 'angle' on a ring of 'numRollers' rollers, given the average B-field.
float seg_roller_torque(const SEGRollerState& r, float B_avg, int numRollers);

/// Advance a single SEG roller by dt using a classical RK4 integrator.
/// loadTorque is the braking torque opposing rotation (positive value).
void  seg_roller_rk4(SEGRollerState& r, float dt, float loadTorque);

/// Symplectic-Euler step for a single SEG particle (mirrors compute.wgsl mode-0).
void  seg_particle_step(SimParticle& p, float omega, float corona, float dt);

// ─────────────────────────────────────────────────────────────
// SEGSimulator  –  high-level class
// ─────────────────────────────────────────────────────────────
class SEGSimulator {
public:
    // Ring layout: inner(12) + middle(22) + outer(32) = 66 rollers
    static constexpr int RING_COUNTS[3]  = {12, 22, 32};
    static constexpr float RING_RADII[3] = {3.5f, 5.5f, 7.5f};
    static constexpr int   MAX_ROLLERS   = 66;
    static constexpr int   MAX_PARTICLES = 50000;

    SEGSimulator();

    /// Advance all rollers by dt with the given electrical load torque (N·m).
    void step(float dt, float loadTorque);

    /// Seed the internal CPU-side particle array for the SEG mode.
    void seedParticles(int count);

    /// Advance all particles by dt (SEG mode kinematics).
    void stepParticles(float dt);

    // ── Accessors ──────────────────────────────────────────────
    float getOmega()        const { return _rollers[0].omega; }
    float getRPM()          const { return _rollers[0].omega * 60.f / PhysicsConstants::TAU; }
    float getAngle(int i)   const { return _rollers[i].angle; }
    int   numRollers()      const { return _numRollers; }
    int   numParticles()    const { return _numParticles; }

    /// Sample the net B-field vector at a world position from all rollers.
    Vec3  sampleBField(Vec3 worldPos) const;

    /// World position of roller i.
    Vec3  rollerWorldPos(int i) const;

    /// Estimate instantaneous power output (W, scene-scaled) from roller dynamics.
    float estimatePower(float loadTorque) const;

    /// Magnetic energy density (J m⁻³) at the average ring radius.
    float magneticEnergyDensity() const;

    /// Read particle position for index i (for optional JS readback).
    SimParticle getParticle(int i) const;

    /// Version string.
    static const char* version();

private:
    SEGRollerState _rollers[MAX_ROLLERS];
    int            _numRollers{0};

    SimParticle    _particles[MAX_PARTICLES];
    int            _numParticles{0};

    float          _time{0.f};
    float          _Br{PhysicsConstants::Br_DEFAULT};

    void _initRollers();
};

// ─────────────────────────────────────────────────────────────
// Version
// ─────────────────────────────────────────────────────────────
inline const char* sim_core_version() { return SEGSimulator::version(); }

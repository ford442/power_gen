#pragma once
// =============================================================
// sim_core.h  –  SEG simulation core  (C++17, WASM-compatible)
// =============================================================
//
// Modes: SEG (RK4 rollers), Heron (Bernoulli / Swamee–Jain head),
//        Kelvin (capacitive voltage + spark), Solar (battery SOC).
// Zero-copy: getParticleBufferPtr / getRollerStatePtr → HEAPF32 views.
// =============================================================

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

// ─────────────────────────────────────────────────────────────
// Vec3
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
        return { y*o.z - z*o.y, z*o.x - x*o.z, x*o.y - y*o.x };
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
// SimParticle  (32 bytes; mirrors src/shaders/common/particle.wgsl SimParticle.
// Interactive WebGPU path uses GpuParticle 16 B — see docs/SHADERS.md.)
// ─────────────────────────────────────────────────────────────
struct SimParticle {
    float x, y, z;
    float phase;
    float vx, vy, vz;
    float aux;   // Kelvin: charge; Solar: absorb flag; Heron: droplet life
};

// ─────────────────────────────────────────────────────────────
// SEGRollerState
// ─────────────────────────────────────────────────────────────
struct SEGRollerState {
    float omega;
    float angle;
    float radius;
    float height;
    float torque;
    float inertia;
};

// Packed roller export: 4 floats per roller for GPU instance upload
// [angle, omega, radius, height]
static constexpr int ROLLER_EXPORT_STRIDE = 4;

// ─────────────────────────────────────────────────────────────
// Physics constants
// ─────────────────────────────────────────────────────────────
struct PhysicsConstants {
    static constexpr float MU_0       = 1.2566370614e-7f;
    static constexpr float EPSILON_0  = 8.854187817e-12f;
    static constexpr float G          = 9.80665f;
    static constexpr float PI         = 3.14159265359f;
    static constexpr float TAU        = 6.28318530718f;
    static constexpr float Br_DEFAULT = 1.48f;
    static constexpr float MU_R       = 1.05f;
};

// ─────────────────────────────────────────────────────────────
// Free functions
// ─────────────────────────────────────────────────────────────
Vec3  magneticDipoleField(Vec3 r, Vec3 m);
Vec3  magneticDipoleForce(Vec3 pos1, Vec3 m1, Vec3 pos2, Vec3 m2);
float axialBField(float z, float radius, float height, float Br);
float seg_roller_torque(const SEGRollerState& r, float B_avg, int numRollers);
void  seg_roller_rk4(SEGRollerState& r, float dt, float loadTorque);
void  seg_particle_step(SimParticle& p, float omega, float corona, float dt);

// Mode-specific particle helpers
void heron_particle_step(SimParticle& p, float vExit, float dt, float simTime);
void kelvin_particle_step(SimParticle& p, float kelvinE, float dt, float simTime);
void solar_particle_step(SimParticle& p, float transmittance, float dt, float simTime);

// ─────────────────────────────────────────────────────────────
// SimMode
// ─────────────────────────────────────────────────────────────
enum SimMode {
    SIM_MODE_SEG   = 0,
    SIM_MODE_HERON = 1,
    SIM_MODE_KELVIN = 2,
    SIM_MODE_SOLAR = 3
};

// ─────────────────────────────────────────────────────────────
// Mode plant state (mirrors device-physics.js / led-solar constants)
// ─────────────────────────────────────────────────────────────
struct HeronState {
    float head{0.f};          // m
    float headMax{4.5f};      // m
    float vExit{0.f};         // m/s scene
    float flowLmin{0.f};
    float pressureKPa{0.f};
    float reynolds{0.f};
    float pumpRate{2.2f};
    float drainCoeff{0.30f};
    float pipeLengthM{2.5f};
    float pipeDiameterM{0.012f};
    float dischargeCoeff{0.35f};
    float roughnessM{1.5e-5f};
    float drive{0.f};         // 0..1
};

struct KelvinState {
    float voltage{0.f};       // V
    float vBreak{60000.f};    // V (E_BREAKDOWN * gap)
    float sparkTimer{0.f};
    float sparkDur{0.18f};
    float voltageN{0.f};      // 0..1
    float E{0.f};             // upward accel coeff
    float drive{0.f};
};

struct SolarState {
    float batteryCharge{0.5f}; // 0..1 SOC
    float ledPower{0.f};       // 0..1 drive
    float transmittance{0.04f};
    float opticalEff{0.45f};   // panel optical→electrical
    float ledWallPlug{0.30f};  // electrical→optical
};

// ─────────────────────────────────────────────────────────────
// SEGSimulator
// ─────────────────────────────────────────────────────────────
class SEGSimulator {
public:
    static constexpr int RING_COUNTS[3]  = {12, 22, 32};
    static constexpr float RING_RADII[3] = {3.5f, 5.5f, 7.5f};
    static constexpr int   MAX_ROLLERS   = 66;
    static constexpr int   MAX_PARTICLES = 50000;

    SEGSimulator();

    void step(float dt, float loadTorque);
    void seedParticles(int count);
    void stepParticles(float dt);

    void setRingLoadTorque(int ring, float torque);
    void setRingLoadTorques(float tInner, float tMiddle, float tOuter);
    void stepWithPerRingTorques(float dt);

    void setMode(int mode);
    int  getMode() const;

    /// Drive setpoint 0..1 (Heron pump / Kelvin charge / Solar LED)
    void setDrive(float drive);
    float getDrive() const { return _drive; }

    // ── Mode plant accessors ──────────────────────────────────
    float getHeronHead() const { return _heron.head; }
    float getHeronVExit() const { return _heron.vExit; }
    float getHeronFlowLmin() const { return _heron.flowLmin; }
    float getHeronPressureKPa() const { return _heron.pressureKPa; }
    float getKelvinVoltage() const { return _kelvin.voltage; }
    float getKelvinVoltageN() const { return _kelvin.voltageN; }
    float getKelvinE() const { return _kelvin.E; }
    float getKelvinSparkTimer() const { return _kelvin.sparkTimer; }
    float getSolarBattery() const { return _solar.batteryCharge; }

    // ── Accessors ─────────────────────────────────────────────
    float getOmega()        const { return _rollers[0].omega; }
    float getRPM()          const { return _rollers[0].omega * 60.f / PhysicsConstants::TAU; }
    double getOmegaF64()    const { return static_cast<double>(_rollers[0].omega); }
    double getRPMF64()      const { return static_cast<double>(getRPM()); }
    float getAngle(int i)   const { return _rollers[i].angle; }
    int   numRollers()      const { return _numRollers; }
    int   numParticles()    const { return _numParticles; }
    float getTime()         const { return _time; }

    Vec3  sampleBField(Vec3 worldPos) const;
    Vec3  rollerWorldPos(int i) const;
    float estimatePower(float loadTorque) const;
    float magneticEnergyDensity() const;

    SimParticle getParticle(int i) const;
    std::vector<SimParticle> getParticles(int maxCount = -1) const;

    // ── Zero-copy buffer views (WASM HEAPF32) ──────────────────
    /// Byte offset of particle array in WASM heap (use with HEAPF32).
    uintptr_t getParticleBufferPtr() const;
    /// Number of floats in particle buffer (numParticles * 8).
    int getParticleFloatCount() const;
    /// Packed roller state [angle, omega, radius, height] * numRollers.
    /// Call packRollerState() first (also called by step).
    uintptr_t getRollerStatePtr() const;
    int getRollerStateFloatCount() const;
    void packRollerState();

    /// Energy / mode scalar for telemetry (0..1-ish)
    float getEnergyLevel() const;

    static const char* version();

private:
    SEGRollerState _rollers[MAX_ROLLERS];
    int            _numRollers{0};

    SimParticle    _particles[MAX_PARTICLES];
    int            _numParticles{0};

    // Contiguous export for rollers (GPU upload)
    float          _rollerExport[MAX_ROLLERS * ROLLER_EXPORT_STRIDE]{};

    float          _time{0.f};
    float          _Br{PhysicsConstants::Br_DEFAULT};
    float          _drive{0.f};

    int            _mode{ SIM_MODE_SEG };
    float          _ringLoadTorques[3]{ 0.f, 0.f, 0.f };

    HeronState     _heron;
    KelvinState    _kelvin;
    SolarState     _solar;

    void _initRollers();
    void _stepHeron(float dt);
    void _stepKelvin(float dt);
    void _stepSolar(float dt);
    void _stepSegRollers(float dt);
};

inline const char* sim_core_version() { return SEGSimulator::version(); }

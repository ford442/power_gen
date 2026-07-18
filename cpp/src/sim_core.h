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

#include "../../generated/constants.h"

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
void peltier_particle_step(SimParticle& p, float deltaTN, float dt, float simTime);
void mhd_particle_step(SimParticle& p, float flowU, float bField, float dt, float simTime);

// ─────────────────────────────────────────────────────────────
// SimMode
// ─────────────────────────────────────────────────────────────
enum SimMode {
    SIM_MODE_SEG   = 0,
    SIM_MODE_HERON = 1,
    SIM_MODE_KELVIN = 2,
    SIM_MODE_SOLAR = 3,
    SIM_MODE_PELTIER = 4,
    SIM_MODE_MHD = 5
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

/// Simplified 1D thermoelectric stack (Seebeck + Peltier + Joule; Thomson
/// neglected). Constants mirror scientific-data.js PELTIER_DATA (Bi₂Te₃).
struct PeltierState {
    float hotK{293.f};         // hot junction temperature, K
    float coldK{293.f};        // cold junction temperature, K
    float ambientK{293.f};     // K
    float seebeck{4.4e-4f};    // V/K per couple × stack → effective V/K
    float couples{127.f};      // couples in module (effective S = seebeck*couples)
    float rInternalOhm{2.5f};  // module internal resistance
    float rLoadOhm{2.5f};      // matched load
    float conductanceWK{0.5f}; // thermal conductance hot→cold, W/K
    float heatCapHotJK{40.f};  // hot-side lumped heat capacity, J/K
    float heatCapColdJK{60.f}; // cold-side lumped heat capacity (with sink), J/K
    float sinkWK{1.6f};        // cold-side → ambient conductance, W/K
    float heaterMaxW{60.f};    // drive=1 heater input, W
    float deltaTRefK{80.f};    // typicalDeltaT for normalization
    float deltaTK{0.f};        // derived: hotK − coldK
    float currentA{0.f};       // derived
    float voltageV{0.f};       // derived load voltage
    float powerW{0.f};         // derived electrical output
    float cop{0.f};            // derived P_out / Q_in (generator efficiency)
    float drive{0.f};          // 0..1 heater drive
};

/// Hartmann-style MHD channel metaphor: pressure-driven conductive flow
/// retarded by Lorentz braking, inducing a load voltage V = B·u·w.
struct MHDState {
    float flowU{0.f};          // bulk channel velocity, m/s
    float flowUMax{5.f};       // normalization velocity
    float bFieldT{0.2f};       // applied transverse field (drive-scaled)
    float pumpAccel{6.f};      // drive=1 pressure-gradient acceleration, m/s²
    float lorentzK{2.5f};      // effective σB²/ρ braking coefficient, 1/(s·T²)
    float frictionK{0.8f};     // viscous/wall losses, 1/s
    float widthM{0.10f};       // electrode spacing
    float halfGapM{0.05f};     // channel half-gap (Hartmann length)
    float sigmaSm{1.0e6f};     // conductivity, S/m (liquid-metal-ish)
    float rhoKgM3{870.f};      // working-fluid density
    float nuM2s{8.0e-7f};      // kinematic viscosity
    float rLoadOhm{0.05f};
    float rInternalOhm{0.05f};
    float hartmann{0.f};       // derived Ha = B·d·sqrt(σ/(ρν))
    float voltageV{0.f};       // derived load voltage
    float currentA{0.f};       // derived
    float powerW{0.f};         // derived electrical output
    float drive{0.f};          // 0..1 pump/field drive
};

// ─────────────────────────────────────────────────────────────
// SEGSimulator
// ─────────────────────────────────────────────────────────────
class SEGSimulator {
public:
    static constexpr int RING_COUNTS[3]  = {
        power_gen::WasmSegDefaults::RING_COUNTS[0],
        power_gen::WasmSegDefaults::RING_COUNTS[1],
        power_gen::WasmSegDefaults::RING_COUNTS[2]
    };
    static constexpr float RING_RADII[3] = {
        power_gen::WasmSegDefaults::RING_RADII[0],
        power_gen::WasmSegDefaults::RING_RADII[1],
        power_gen::WasmSegDefaults::RING_RADII[2]
    };
    static constexpr int   MAX_ROLLERS   = power_gen::WasmSegDefaults::MAX_ROLLERS;
    static constexpr int   MAX_PARTICLES = power_gen::WasmSegDefaults::MAX_PARTICLES;

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
    float getPeltierHotK() const { return _peltier.hotK; }
    float getPeltierColdK() const { return _peltier.coldK; }
    float getPeltierDeltaT() const { return _peltier.deltaTK; }
    float getPeltierVoltage() const { return _peltier.voltageV; }
    float getPeltierCurrent() const { return _peltier.currentA; }
    float getPeltierPowerW() const { return _peltier.powerW; }
    float getPeltierCOP() const { return _peltier.cop; }
    float getMhdFlowU() const { return _mhd.flowU; }
    float getMhdBFieldT() const { return _mhd.bFieldT; }
    float getMhdHartmann() const { return _mhd.hartmann; }
    float getMhdVoltage() const { return _mhd.voltageV; }
    float getMhdCurrent() const { return _mhd.currentA; }
    float getMhdPowerW() const { return _mhd.powerW; }

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
    PeltierState   _peltier;
    MHDState       _mhd;

    void _initRollers();
    void _stepHeron(float dt);
    void _stepKelvin(float dt);
    void _stepSolar(float dt);
    void _stepPeltier(float dt);
    void _stepMHD(float dt);
    void _stepSegRollers(float dt);
};

inline const char* sim_core_version() { return SEGSimulator::version(); }

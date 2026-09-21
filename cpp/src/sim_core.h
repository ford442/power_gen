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
#include "../../generated/device-catalog.h"

// ─────────────────────────────────────────────────────────────
// Free functions
// ─────────────────────────────────────────────────────────────
Vec3  magneticDipoleField(Vec3 r, Vec3 m);
Vec3  magneticDipoleForce(Vec3 pos1, Vec3 m1, Vec3 pos2, Vec3 m2);
float axialBField(float z, float radius, float height, float Br);
/// Order-of-magnitude Halbach ring surface field vs gap (mirrors JS estimateHalbachFieldT).
float estimateHalbachFieldT(float gapM, float remanenceT = 0.f);
float seg_roller_torque(const SEGRollerState& r, float B_avg, int numRollers);
void  seg_roller_rk4(SEGRollerState& r, float dt, float loadTorque);
void  seg_particle_step(SimParticle& p, float omega, float corona, float dt);

// Mode-specific particle helpers
void heron_particle_step(SimParticle& p, float vExit, float dt, float simTime);
void kelvin_particle_step(SimParticle& p, float kelvinE, float dt, float simTime);
void solar_particle_step(SimParticle& p, float transmittance, float dt, float simTime);
void peltier_particle_step(SimParticle& p, float deltaTN, float dt, float simTime);
void mhd_particle_step(SimParticle& p, float flowU, float bField, float dt, float simTime);

/// gpu-chores: packed f32 reduce. out[5] = {sum, min, max, sumSq, count}.
void chores_reduce_f32(const float* data, int count, float out[5]);
void chores_map_scale_f32(const float* in, float* out, int count, float scale, float bias);
std::vector<float> chores_reduce_f32_vec(const std::vector<float>& data);
std::vector<float> chores_map_scale_f32_vec(const std::vector<float>& data, float scale, float bias);

// SimMode comes from generated/device-catalog.h (physics/devices.json).
// Plant structs live beside their .cpp files (not defined here).

#include "plant/heron_plant.h"
#include "plant/kelvin_plant.h"
#include "plant/solar_plant.h"
#include "plant/peltier_plant.h"
#include "plant/mhd_plant.h"
#include "plant/maglev_plant.h"
#include "plant/homopolar_plant.h"
#include "plant/transformer_plant.h"
#include "plant/vdg_plant.h"
#include "plant/hall_plant.h"
#include "plant/lorentz_plant.h"
#include "plant/thomson_plant.h"
#include "plant/energy_network.h"

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

    float getMaglevGap() const { return _maglev.gap; }
    float getMaglevGapVel() const { return _maglev.gapVel; }
    float getMaglevGapMm() const { return _maglev.gapMm; }
    float getMaglevFieldT() const { return _maglev.fieldT; }
    float getMaglevLiftN() const { return _maglev.liftN; }
    float getMaglevRpm() const { return _maglev.rpm; }

    float getHomopolarOmega() const { return _homopolar.omega; }
    float getHomopolarAngle() const { return _homopolar.angle; }
    float getHomopolarRpm() const { return _homopolar.rpm; }
    float getHomopolarEmfV() const { return _homopolar.emfV; }
    float getHomopolarCurrentA() const { return _homopolar.currentA; }
    float getHomopolarFieldT() const { return _homopolar.fieldT; }

    float getTransformerI1() const { return _transformer.i1; }
    float getTransformerI2() const { return _transformer.i2; }
    float getTransformerV1() const { return _transformer.v1; }
    float getTransformerV2() const { return _transformer.v2; }
    float getTransformerK() const { return _transformer.k; }
    float getTransformerFluxN() const { return _transformer.fluxN; }
    bool  getTransformerLeakage() const { return _transformer.leakage; }
    void  setTransformerLeakage(bool enabled);

    float getVdgVoltage() const { return _vdg.voltage; }
    float getVdgBeltMps() const { return _vdg.beltMps; }
    float getVdgChargeC() const { return _vdg.chargeC; }
    float getVdgSparkHz() const { return _vdg.sparkHz; }

    float getHallVoltage() const { return _hall.voltage; }
    float getHallCurrent() const { return _hall.current; }
    float getHallFieldT() const { return _hall.fieldT; }
    float getHallCoeff() const { return _hall.coeff; }
    bool  getHallCarrierMetal() const { return _hall.carrierMetal; }
    void  setHallCarrierMetal(bool metal);
    void  setHallFieldCoupledT(float fieldT);

    float getLorentzSledVms() const { return _lorentz.velocityMps; }
    float getLorentzCurrentA() const { return _lorentz.currentA; }
    float getLorentzFieldT() const { return _lorentz.fieldT; }
    float getLorentzForceN() const { return _lorentz.forceN; }
    float getLorentzPositionM() const { return _lorentz.positionM; }
    void  setLorentzFieldT(float fieldT);

    float getRingHeightM() const { return _thomson.heightM; }
    float getRingCurrentA() const { return _thomson.ringCurrentA; }
    float getRingPrimaryIA() const { return _thomson.primaryIA; }
    float getRingForceN() const { return _thomson.forceN; }
    float getRingCouplingK() const { return _thomson.couplingK; }
    float getRingVelocityMps() const { return _thomson.velocityMps; }

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

    // ── Lab energy bus (ADR-0004 Phase B) ─────────────────────
    /// Replace edge list. Flat layout per edge: fromMode, toMode, maxWatts, efficiency, latencyS.
    void setNetworkEdges(const std::vector<float>& flatEdges);
    int  getNetworkEdgeCount() const { return static_cast<int>(_networkEdges.size()); }
    /// Per-mode energyLevel (0..1) and enabled flags (0/1), length ENERGY_NETWORK_MODE_COUNT.
    void updateEnergyNetwork(
        bool couplingEnabled,
        float segPowerW,
        float segEfficiencyPct,
        const std::vector<float>& energyLevels,
        const std::vector<int>& enabledFlags);
    EnergyNetworkSummary getNetworkSummary() const { return _networkSummary; }
    float getNetworkEdgeAllocatedW(int edgeIndex) const;
    EnergyNetworkDevicePower getNetworkDevicePower(int mode) const;

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
    MaglevState      _maglev;
    HomopolarState   _homopolar;
    TransformerState _transformer;
    VdgState         _vdg;
    HallState        _hall;
    LorentzState     _lorentz;
    ThomsonState     _thomson;

    // Lab energy bus state
    std::vector<EnergyNetworkEdgeSpec> _networkEdges;
    std::vector<float>                 _networkEdgeAllocatedW;
    EnergyNetworkDevicePower           _networkDevicePower[ENERGY_NETWORK_MODE_COUNT]{};
    EnergyNetworkSummary               _networkSummary{};

    void _initRollers();
    void _stepHeron(float dt);
    void _stepKelvin(float dt);
    void _stepSolar(float dt);
    void _stepPeltier(float dt);
    void _stepMHD(float dt);
    void _stepMaglev(float dt);
    void _stepHomopolar(float dt);
    void _stepTransformer(float dt);
    void _stepVdg(float dt);
    void _stepHall(float dt);
    void _stepLorentz(float dt);
    void _stepThomson(float dt);
    void _stepSegRollers(float dt);
};

inline const char* sim_core_version() { return SEGSimulator::version(); }

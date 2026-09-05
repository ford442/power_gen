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

/// Maglev gap ODE — mirrors Quanta JS spring–damper (magnetic-levitation.js).
struct MaglevState {
    float gap{0.018f};         // m
    float gapVel{0.f};         // m/s
    float gapMm{18.f};
    float fieldT{0.f};
    float liftN{0.f};
    float rpm{0.f};
    float kSpring{180.f};
    float cDamp{14.f};
    float mass{0.045f};
    float drive{0.f};
};

/// Homopolar Faraday disc L–R + back-EMF — mirrors homopolar-generator.js.
struct HomopolarState {
    float omega{0.f};          // rad/s
    float angle{0.f};          // rad
    float rpm{0.f};
    float emfV{0.f};
    float currentA{0.f};
    float fieldT{0.55f};
    float discRadiusM{0.14f};
    float rOhm{0.008f};
    float lHenry{0.0015f};
    float inertia{0.002f};
    float drag{0.0008f};
    float tauDriveMax{0.15f};
    float drive{0.f};
};

/// Coupled-inductor two-winding transformer — Quanta classroom L–M ODE.
/// Mirrors TRANSFORMER constants in devices/quanta/transformer.ts.
struct TransformerState {
    float i1{0.f};             // primary current, A
    float i2{0.f};             // secondary current, A
    float v1{0.f};             // primary drive voltage, V
    float v2{0.f};             // secondary terminal voltage (−R_load i2), V
    float k{0.97f};            // coupling coefficient
    float fluxN{0.f};          // normalized flux linkage 0..1
    float phase{0.f};          // rad, ωt
    float fHz{60.f};
    float l1H{0.85f};
    float l2H{0.095f};
    float kIdeal{0.97f};
    float kLeakage{0.72f};
    float r1Ohm{1.8f};
    float r2Ohm{0.45f};
    float rLoadOhm{12.f};
    float vPeak{28.f};
    bool  leakage{false};
    float drive{0.f};
};

/// Van de Graaff belt-charge / isolated-sphere / spark-gap ODE — mirrors
/// VDG constants in devices/quanta/van-de-graaff.ts. Isolated-sphere
/// capacitance C = 4*pi*eps0*r (r=0.14m); breakdown V = E_air(3e6 V/m) *
/// gapM(0.05m), same rule of thumb KelvinState uses for its spark gap.
struct VdgState {
    float chargeC{0.f};              // sphere charge, C
    float voltage{0.f};              // sphere voltage, V (= chargeC / capacitanceF)
    float beltMps{0.f};              // belt surface speed, m/s
    float capacitanceF{1.5567e-11f}; // isolated sphere, C = 4*pi*eps0*r
    float vBreak{150000.f};          // V
    float beltMaxMps{6.f};
    float beltMaxCurrentA{2.2e-6f};  // charge transfer current at full belt speed
    float leakageROhm{5.0e13f};      // air/corona leakage resistance
    float sparkDischargeFrac{0.05f}; // fraction of charge remaining right after a spark
    float sparkTimer{0.f};
    float sparkDurS{0.15f};
    float sparkAccum{0.f};           // sparks counted in the current rate window
    float sparkWindowT{0.f};
    float sparkWindowS{1.f};
    float sparkHz{0.f};              // derived rolling spark rate
    float drive{0.f};
};

/// Hall-effect bench: I, B -> Hall voltage V_H = I*B/(n*e*t), R_H = 1/(n*e)
/// — mirrors HALL constants in devices/quanta/hall-effect.ts. `carrierMetal`
/// toggles the classroom semiconductor-vs-metal carrier-density comparison.
struct HallState {
    float current{0.f};        // strip current, A
    float fieldT{0.f};         // applied field, T
    float voltage{0.f};        // derived Hall voltage, V
    float coeff{0.f};          // derived R_H = 1/(n*e), m^3/C
    float iMaxA{1.2f};
    float bMaxT{0.65f};
    float smoothingTau{0.25f};
    bool  carrierMetal{false}; // false = semiconductor (n~1e21/m^3), true = metal (n~8.5e28/m^3)
    float drive{0.f};
};

/// Lorentz rail sled: series R-L drive loop closed through a sliding
/// armature. L dI/dt = V - I R - B l v ; m dv/dt = I l B - friction.
/// Mirrors LORENTZ in devices/quanta/lorentz-sled.ts. Educational
/// Lorentz-force model — no projectile or ballistics state exists here.
struct LorentzState {
    float currentA{0.f};    // armature / loop current, A
    float velocityMps{0.f}; // sled speed along the rails, m/s
    float positionM{0.f};   // position along the rails, m (wraps at railLengthM)
    float forceN{0.f};      // derived Lorentz force I*l*B, N
    float fieldT{0.8f};     // local bench field B, T (slider parameter)
    float fieldTMax{1.2f};
    float railLengthM{2.0f};
    float railGapM{0.25f};   // l — rail separation the armature bridges
    float massKg{0.15f};
    float supplyVMax{12.f};
    float rOhm{0.6f};
    float lHenry{6.0e-5f};   // tau = L/R ~ 100 us -> analytic RL update
    float frictionMu{0.25f};
    float viscousNsm{0.3f};
    float vEpsMps{0.05f};    // tanh regularisation width for Coulomb friction
    float vMaxMps{12.f};     // display normaliser (energyLevel)
    float drive{0.f};
};

// ─────────────────────────────────────────────────────────────
// Lab energy bus (ADR-0004 Phase B) — declarative edges + budget
// ─────────────────────────────────────────────────────────────
struct EnergyNetworkEdgeSpec {
    int   fromMode{0};
    int   toMode{0};
    float maxWatts{0.f};
    float efficiency{1.f};
    float latencyS{0.f};
};

struct EnergyNetworkDevicePower {
    float powerInW{0.f};
    float powerOutW{0.f};
    float efficiency{0.f};
};

struct EnergyNetworkSummary {
    bool  couplingEnabled{false};
    float labBudgetW{0.f};
    float totalAllocatedW{0.f};
    float residualW{0.f};
};

static constexpr int ENERGY_NETWORK_MODE_COUNT = power_gen::EnergyNetworkNameplates::MODE_COUNT;

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

    float getLorentzSledVms() const { return _lorentz.velocityMps; }
    float getLorentzCurrentA() const { return _lorentz.currentA; }
    float getLorentzFieldT() const { return _lorentz.fieldT; }
    float getLorentzForceN() const { return _lorentz.forceN; }
    float getLorentzPositionM() const { return _lorentz.positionM; }
    void  setLorentzFieldT(float fieldT);

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
    void _stepSegRollers(float dt);
};

inline const char* sim_core_version() { return SEGSimulator::version(); }

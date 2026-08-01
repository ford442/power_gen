// =============================================================
// sim_core.cpp  –  SEG simulation core façade
// =============================================================
//
// Per-plant physics implementations live in plant/*.cpp (see
// cpp/README.md and docs/MODE_MATRIX.md). This file keeps:
//   - the SEGSimulator constructor and top-level dispatch (step,
//     setMode/getMode, stepWithPerRingTorques switch),
//   - the cross-mode accessors (estimatePower, getEnergyLevel),
//   - the Emscripten --bind surface (unchanged signatures),
//   - the standalone native smoke-test driver.
// =============================================================

#include "sim_core.h"
#include "plant/plant_common.h"

#ifdef __EMSCRIPTEN__
#  include <emscripten/bind.h>
#  include <string>
using namespace emscripten;
#endif

#include <cstdlib>
#include <ctime>
#include <vector>
#include <algorithm>

using namespace plant_common;

// ─────────────────────────────────────────────────────────────
// SEGSimulator
// ─────────────────────────────────────────────────────────────

SEGSimulator::SEGSimulator() {
    _initRollers();
    lcg_state = static_cast<uint32_t>(std::time(nullptr));
    // Kelvin breakdown: E_BREAKDOWN ~ 3e6 V/m * 0.02 m gap
    _kelvin.vBreak = 3.0e6f * 0.02f;
    _homopolar.fieldT = std::min(0.55f, PhysicsConstants::Br_DEFAULT * 0.28f);
    _maglev.fieldT = estimateHalbachFieldT(_maglev.gap);
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
    _peltier.drive = _drive;
    _mhd.drive = _drive;
    _maglev.drive = _drive;
    _homopolar.drive = _drive;
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
        case SIM_MODE_PELTIER:
            _stepPeltier(dt);
            break;
        case SIM_MODE_MHD:
            _stepMHD(dt);
            break;
        case SIM_MODE_MAGLEV:
            _stepMaglev(dt);
            break;
        case SIM_MODE_HOMOPOLAR:
            _stepHomopolar(dt);
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
    if (mode >= 0 && mode <= SIM_MODE_HOMOPOLAR) _mode = mode;
}

int SEGSimulator::getMode() const { return _mode; }

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
    if (_mode == SIM_MODE_PELTIER) return _peltier.powerW;
    if (_mode == SIM_MODE_MHD)     return _mhd.powerW;
    if (_mode == SIM_MODE_MAGLEV)  return _maglev.liftN * _maglev.gapVel; // mechanical proxy
    if (_mode == SIM_MODE_HOMOPOLAR) return _homopolar.emfV * _homopolar.currentA;
    if (_numRollers == 0) return 0.f;
    return loadTorque * _rollers[0].omega * static_cast<float>(_numRollers) / 3.f;
}

float SEGSimulator::getEnergyLevel() const {
    switch (_mode) {
        case SIM_MODE_HERON: {
            float vRef = std::sqrt(2.f * PhysicsConstants::G * _heron.headMax) * _heron.dischargeCoeff;
            return clampf(_heron.vExit / std::max(vRef, 0.5f), 0.f, 1.f);
        }
        case SIM_MODE_KELVIN: return _kelvin.voltageN;
        case SIM_MODE_SOLAR:  return _solar.batteryCharge;
        case SIM_MODE_PELTIER:
            return clampf(_peltier.deltaTK / _peltier.deltaTRefK, 0.f, 1.f);
        case SIM_MODE_MHD:
            return clampf(_mhd.flowU / std::max(_mhd.flowUMax, 0.1f), 0.f, 1.f);
        case SIM_MODE_MAGLEV: {
            float gapTarget = 0.012f + 0.022f * _maglev.drive;
            float err = std::abs(_maglev.gap - gapTarget) / std::max(gapTarget, 0.01f);
            return clampf(_maglev.drive * 0.55f + (1.f - err) * 0.45f, 0.f, 1.f);
        }
        case SIM_MODE_HOMOPOLAR:
            return clampf(_homopolar.drive * 0.45f + (_homopolar.rpm / 3600.f) * 0.55f, 0.f, 1.f);
        default:
            return clampf(_rollers[0].omega / 50.f, 0.f, 1.f);
    }
}

const char* SEGSimulator::version() {
    return "sim_core 1.4.0";
}

// ─────────────────────────────────────────────────────────────
// Emscripten / Embind
// ─────────────────────────────────────────────────────────────
#ifdef __EMSCRIPTEN__

EMSCRIPTEN_BINDINGS(sim_core) {
    value_object<EnergyNetworkSummary>("EnergyNetworkSummary")
        .field("couplingEnabled", &EnergyNetworkSummary::couplingEnabled)
        .field("labBudgetW", &EnergyNetworkSummary::labBudgetW)
        .field("totalAllocatedW", &EnergyNetworkSummary::totalAllocatedW)
        .field("residualW", &EnergyNetworkSummary::residualW);

    value_object<EnergyNetworkDevicePower>("EnergyNetworkDevicePower")
        .field("powerInW", &EnergyNetworkDevicePower::powerInW)
        .field("powerOutW", &EnergyNetworkDevicePower::powerOutW)
        .field("efficiency", &EnergyNetworkDevicePower::efficiency);

    register_vector<float>("FloatVector");
    register_vector<int>("IntVector");

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
    function("estimateHalbachFieldT", optional_override([](float gapM, float remanenceT) -> float {
        return estimateHalbachFieldT(gapM, remanenceT);
    }));
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
        .function("getPeltierHotK", &SEGSimulator::getPeltierHotK)
        .function("getPeltierColdK", &SEGSimulator::getPeltierColdK)
        .function("getPeltierDeltaT", &SEGSimulator::getPeltierDeltaT)
        .function("getPeltierVoltage", &SEGSimulator::getPeltierVoltage)
        .function("getPeltierCurrent", &SEGSimulator::getPeltierCurrent)
        .function("getPeltierPowerW", &SEGSimulator::getPeltierPowerW)
        .function("getPeltierCOP", &SEGSimulator::getPeltierCOP)
        .function("getMhdFlowU", &SEGSimulator::getMhdFlowU)
        .function("getMhdBFieldT", &SEGSimulator::getMhdBFieldT)
        .function("getMhdHartmann", &SEGSimulator::getMhdHartmann)
        .function("getMhdVoltage", &SEGSimulator::getMhdVoltage)
        .function("getMhdCurrent", &SEGSimulator::getMhdCurrent)
        .function("getMhdPowerW", &SEGSimulator::getMhdPowerW)
        .function("getMaglevGap", &SEGSimulator::getMaglevGap)
        .function("getMaglevGapVel", &SEGSimulator::getMaglevGapVel)
        .function("getMaglevGapMm", &SEGSimulator::getMaglevGapMm)
        .function("getMaglevFieldT", &SEGSimulator::getMaglevFieldT)
        .function("getMaglevLiftN", &SEGSimulator::getMaglevLiftN)
        .function("getMaglevRpm", &SEGSimulator::getMaglevRpm)
        .function("getHomopolarOmega", &SEGSimulator::getHomopolarOmega)
        .function("getHomopolarAngle", &SEGSimulator::getHomopolarAngle)
        .function("getHomopolarRpm", &SEGSimulator::getHomopolarRpm)
        .function("getHomopolarEmfV", &SEGSimulator::getHomopolarEmfV)
        .function("getHomopolarCurrentA", &SEGSimulator::getHomopolarCurrentA)
        .function("getHomopolarFieldT", &SEGSimulator::getHomopolarFieldT)
        .function("getEnergyLevel", &SEGSimulator::getEnergyLevel)
        .function("setNetworkEdges", &SEGSimulator::setNetworkEdges)
        .function("getNetworkEdgeCount", &SEGSimulator::getNetworkEdgeCount)
        .function("updateEnergyNetwork", &SEGSimulator::updateEnergyNetwork)
        .function("getNetworkSummary", &SEGSimulator::getNetworkSummary)
        .function("getNetworkEdgeAllocatedW", &SEGSimulator::getNetworkEdgeAllocatedW)
        .function("getNetworkDevicePower", &SEGSimulator::getNetworkDevicePower)
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

static int run_peltier_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_PELTIER);
    sim.setDrive(1.f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 3600; ++i) { // 60 s to let the stack heat up
        sim.step(dt, 0.f);
        if ((i & 7) == 0) sim.stepParticles(dt);
    }
    printf("Peltier Th=%.1f K  Tc=%.1f K  dT=%.1f K  V=%.3f V  I=%.3f A  P=%.3f W  eff=%.3f\n",
           sim.getPeltierHotK(), sim.getPeltierColdK(), sim.getPeltierDeltaT(),
           sim.getPeltierVoltage(), sim.getPeltierCurrent(),
           sim.getPeltierPowerW(), sim.getPeltierCOP());
    if (sim.getPeltierDeltaT() <= 1.f || sim.getPeltierPowerW() <= 0.f) {
        printf("FAIL: Peltier stack did not develop dT / power\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Peltier energy level out of range\n");
        return 1;
    }
    printf("Peltier smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_mhd_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MHD);
    sim.setDrive(0.9f);
    sim.seedParticles(500);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) {
        sim.step(dt, 0.f);
        sim.stepParticles(dt);
    }
    printf("MHD u=%.3f m/s  B=%.3f T  Ha=%.0f  V=%.4f V  I=%.3f A  P=%.4f W\n",
           sim.getMhdFlowU(), sim.getMhdBFieldT(), sim.getMhdHartmann(),
           sim.getMhdVoltage(), sim.getMhdCurrent(), sim.getMhdPowerW());
    if (sim.getMhdFlowU() <= 0.f || sim.getMhdVoltage() <= 0.f) {
        printf("FAIL: MHD channel did not develop flow / voltage\n");
        return 1;
    }
    if (sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: MHD energy level out of range\n");
        return 1;
    }
    printf("MHD smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_maglev_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_MAGLEV);
    sim.setDrive(0.85f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 600; ++i) sim.step(dt, 0.f);
    printf("Maglev gap=%.4f m (%.2f mm)  B=%.3f T  lift=%.3f N  rpm=%.0f\n",
           sim.getMaglevGap(), sim.getMaglevGapMm(),
           sim.getMaglevFieldT(), sim.getMaglevLiftN(), sim.getMaglevRpm());
    if (sim.getMaglevGap() <= 0.f || sim.getMaglevFieldT() <= 0.f
        || !std::isfinite(sim.getMaglevGap()) || !std::isfinite(sim.getMaglevRpm())) {
        printf("FAIL: Maglev gap / field did not develop\n");
        return 1;
    }
    if (sim.getMaglevRpm() <= 0.f) {
        printf("FAIL: Maglev RPM stayed zero under drive\n");
        return 1;
    }
    if (!std::isfinite(sim.getEnergyLevel()) || sim.getEnergyLevel() < 0.f || sim.getEnergyLevel() > 1.f) {
        printf("FAIL: Maglev energy level out of range\n");
        return 1;
    }
    printf("Maglev smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_homopolar_smoke() {
    SEGSimulator sim;
    sim.setMode(SIM_MODE_HOMOPOLAR);
    sim.setDrive(0.9f);
    const float dt = 1.f / 60.f;
    for (int i = 0; i < 900; ++i) sim.step(dt, 0.f);
    printf("Homopolar rpm=%.1f  EMF=%.4f V  I=%.3f A  B=%.3f T\n",
           sim.getHomopolarRpm(), sim.getHomopolarEmfV(),
           sim.getHomopolarCurrentA(), sim.getHomopolarFieldT());
    if (sim.getHomopolarRpm() <= 0.f || sim.getHomopolarEmfV() <= 0.f) {
        printf("FAIL: Homopolar disc did not develop RPM / EMF\n");
        return 1;
    }
    if (sim.getHomopolarCurrentA() <= 0.f) {
        printf("FAIL: Homopolar current stayed zero\n");
        return 1;
    }
    printf("Homopolar smoke OK (energyLevel=%.3f)\n", sim.getEnergyLevel());
    return 0;
}

static int run_energy_network_smoke() {
    SEGSimulator sim;
    // Mirror ENERGY_PIPE_EDGES (from, to, maxW, eff, latency)
    const float edges[] = {
        0, 1, 1500.f, 1.f, 0.f,
        1, 2,  800.f, 1.f, 0.f,
        2, 0,  600.f, 1.f, 0.f,
        2, 4,  400.f, 1.f, 0.f,
        4, 3,  500.f, 1.f, 0.f,
        0, 5, 1200.f, 1.f, 0.f,
        5, 4,  700.f, 1.f, 0.f,
        3, 6,  450.f, 1.f, 0.f,
        6, 0,  550.f, 1.f, 0.f,
    };
    sim.setNetworkEdges(std::vector<float>(edges, edges + sizeof(edges) / sizeof(edges[0])));

    const float dt = 1.f / 60.f;
    const int steps = static_cast<int>(1.2f / dt); // ≥1 s
    std::vector<float> energyLevels(ENERGY_NETWORK_MODE_COUNT, 0.f);
    std::vector<int> enabled(ENERGY_NETWORK_MODE_COUNT, 1);

    for (int i = 0; i < steps; ++i) {
        // Advance a few mode plants and feed bus with synthetic levels
        sim.setMode(SIM_MODE_SEG);
        sim.setDrive(0.7f);
        sim.step(dt, 0.01f);
        energyLevels[SIM_MODE_SEG] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_HERON);
        sim.setDrive(0.8f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_HERON] = sim.getEnergyLevel();

        sim.setMode(SIM_MODE_KELVIN);
        sim.setDrive(0.9f);
        sim.step(dt, 0.f);
        energyLevels[SIM_MODE_KELVIN] = sim.getEnergyLevel();

        const float segPowerW = sim.estimatePower(0.01f);
        sim.updateEnergyNetwork(true, segPowerW, 88.f, energyLevels, enabled);

        const EnergyNetworkSummary sum = sim.getNetworkSummary();
        if (!std::isfinite(sum.labBudgetW) || !std::isfinite(sum.totalAllocatedW)
            || !std::isfinite(sum.residualW)) {
            printf("FAIL: energy bus NaN at step %d\n", i);
            return 1;
        }
        if (sum.labBudgetW < 0.f || sum.totalAllocatedW < 0.f) {
            printf("FAIL: negative bus watts at step %d\n", i);
            return 1;
        }
    }

    const EnergyNetworkSummary finalSum = sim.getNetworkSummary();
    printf("Energy bus: budget=%.1f W  allocated=%.1f W  residual=%.1f W  edges=%d\n",
           finalSum.labBudgetW, finalSum.totalAllocatedW, finalSum.residualW,
           sim.getNetworkEdgeCount());
    if (sim.getNetworkEdgeCount() != 9) {
        printf("FAIL: expected 9 network edges\n");
        return 1;
    }
    if (finalSum.totalAllocatedW <= 0.f) {
        printf("FAIL: no power allocated on coupled bus\n");
        return 1;
    }
    printf("Energy network smoke OK (%.1f s, %d steps)\n", steps * dt, steps);
    return 0;
}

int main(int argc, char** argv) {
    // --mode <peltier|mhd|maglev|homopolar>: run a single-mode smoke test
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
            if (std::strcmp(argv[i + 1], "peltier") == 0) return run_peltier_smoke();
            if (std::strcmp(argv[i + 1], "mhd") == 0)     return run_mhd_smoke();
            if (std::strcmp(argv[i + 1], "maglev") == 0)  return run_maglev_smoke();
            if (std::strcmp(argv[i + 1], "homopolar") == 0) return run_homopolar_smoke();
            if (std::strcmp(argv[i + 1], "energy-network") == 0) return run_energy_network_smoke();
            std::fprintf(stderr, "Unknown --mode %s (expected peltier|mhd|maglev|homopolar|energy-network)\n", argv[i + 1]);
            return 2;
        }
    }
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

    // ── Peltier + MHD + Quanta plugin paths ──
    if (run_peltier_smoke() != 0) return 1;
    if (run_mhd_smoke() != 0) return 1;
    if (run_maglev_smoke() != 0) return 1;
    if (run_homopolar_smoke() != 0) return 1;
    if (run_energy_network_smoke() != 0) return 1;

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
    if (sim.getParticleFloatCount() != 1000 * 8) {
        printf("FAIL: unexpected particle export size (got %d, expected %d)\n",
               sim.getParticleFloatCount(), 1000 * 8);
        return 1;
    }

    printf("All mode smoke tests OK\n");
    return 0;
}
#endif // SIM_CORE_STANDALONE

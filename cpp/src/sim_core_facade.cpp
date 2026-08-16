// =============================================================
// sim_core_facade.cpp  –  SEGSimulator ctor, dispatch, cross-mode accessors
// =============================================================

#include "sim_core.h"
#include "plant/plant_common.h"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <vector>

using namespace plant_common;

SEGSimulator::SEGSimulator() {
    _initRollers();
    lcg_state = static_cast<uint32_t>(std::time(nullptr));
    // Kelvin breakdown: E_BREAKDOWN ~ 3e6 V/m * 0.02 m gap
    _kelvin.vBreak = 3.0e6f * 0.02f;
    _homopolar.fieldT = std::min(0.55f, PhysicsConstants::Br_DEFAULT * 0.28f);
    _maglev.fieldT = estimateHalbachFieldT(_maglev.gap);
    _transformer.k = _transformer.kIdeal;
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
    _transformer.drive = _drive;
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
        case SIM_MODE_TRANSFORMER:
            _stepTransformer(dt);
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
    if (mode >= 0 && mode <= SIM_MODE_TRANSFORMER) _mode = mode;
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
    if (_mode == SIM_MODE_TRANSFORMER) return std::abs(_transformer.v2 * _transformer.i2);
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
        case SIM_MODE_TRANSFORMER:
            return clampf(_transformer.drive * 0.55f
                          + std::abs(_transformer.i2) / 3.f * 0.45f, 0.f, 1.f);
        default:
            return clampf(_rollers[0].omega / 50.f, 0.f, 1.f);
    }
}

const char* SEGSimulator::version() {
    return "sim_core 1.4.0";
}

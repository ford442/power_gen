// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// Per-plant ODE layout for the shared integrators (cpp/src/core/integrate.h):
// the state-index enum a Plant's derivs / save / load use, its catalog
// integrator and tolerances. TS twin: generated/plant-ode.ts.

#pragma once

#include <array>
#include <cstddef>
#include <limits>

#include "../cpp/src/core/integrate.h"

namespace power_gen::ode {

/// Peltier (wasmMode 4, physics/devices.json "peltier").
struct Peltier {
    enum State : std::size_t { nodesK = 0 };
    static constexpr std::size_t nodesK_COUNT = 28;
    static constexpr std::size_t STATE_SIZE = 28;
    enum Output : std::size_t { hotK = 0, coldK = 1, deltaTK = 2, voltageV = 3, powerW = 4, cop = 5, qcW = 6, qhW = 7 };
    static constexpr std::size_t OUTPUT_SIZE = 8;
    static constexpr sim_core::Integrator INTEGRATOR = sim_core::Integrator::Ros23;
    static constexpr float RTOL = 0.00001f;
    static constexpr std::array<float, STATE_SIZE> ATOL = { 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f, 0.001f };
    static constexpr double H_MAX = 2;
    static constexpr const char* STATE_NAMES[STATE_SIZE] = { "nodesK[0]", "nodesK[1]", "nodesK[2]", "nodesK[3]", "nodesK[4]", "nodesK[5]", "nodesK[6]", "nodesK[7]", "nodesK[8]", "nodesK[9]", "nodesK[10]", "nodesK[11]", "nodesK[12]", "nodesK[13]", "nodesK[14]", "nodesK[15]", "nodesK[16]", "nodesK[17]", "nodesK[18]", "nodesK[19]", "nodesK[20]", "nodesK[21]", "nodesK[22]", "nodesK[23]", "nodesK[24]", "nodesK[25]", "nodesK[26]", "nodesK[27]" };

    static sim_core::Tolerance<STATE_SIZE> tolerance() {
        sim_core::Tolerance<STATE_SIZE> t;
        t.rtol = RTOL;
        t.atol = ATOL;
        t.hMax = H_MAX;
        return t;
    }
};

/// Homopolar Generator (wasmMode 7, physics/devices.json "homopolar").
struct Homopolar {
    enum State : std::size_t { omega = 0, currentA = 1 };
    static constexpr std::size_t STATE_SIZE = 2;
    enum Output : std::size_t { emfV = 0 };
    static constexpr std::size_t OUTPUT_SIZE = 1;
    static constexpr sim_core::Integrator INTEGRATOR = sim_core::Integrator::Euler;
    static constexpr float RTOL = 0.0001f;
    static constexpr std::array<float, STATE_SIZE> ATOL = { 0.001f, 0.001f };
    static constexpr double H_MAX = std::numeric_limits<double>::infinity();
    static constexpr const char* STATE_NAMES[STATE_SIZE] = { "omega", "currentA" };

    static sim_core::Tolerance<STATE_SIZE> tolerance() {
        sim_core::Tolerance<STATE_SIZE> t;
        t.rtol = RTOL;
        t.atol = ATOL;
        t.hMax = H_MAX;
        return t;
    }
};

/// Thomson Jumping Ring (wasmMode 12, physics/devices.json "jumping-ring").
struct JumpingRing {
    enum State : std::size_t { primaryIA = 0, ringCurrentA = 1, velocityMps = 2, heightM = 3 };
    static constexpr std::size_t STATE_SIZE = 4;
    enum Output : std::size_t { forceN = 0, couplingK = 1 };
    static constexpr std::size_t OUTPUT_SIZE = 2;
    static constexpr sim_core::Integrator INTEGRATOR = sim_core::Integrator::Dopri5;
    static constexpr float RTOL = 0.0002f;
    static constexpr std::array<float, STATE_SIZE> ATOL = { 0.0034f, 0.16f, 0.00017f, 0.000013f };
    static constexpr double H_MAX = std::numeric_limits<double>::infinity();
    static constexpr const char* STATE_NAMES[STATE_SIZE] = { "primaryIA", "ringCurrentA", "velocityMps", "heightM" };

    static sim_core::Tolerance<STATE_SIZE> tolerance() {
        sim_core::Tolerance<STATE_SIZE> t;
        t.rtol = RTOL;
        t.atol = ATOL;
        t.hMax = H_MAX;
        return t;
    }
};

} // namespace power_gen::ode

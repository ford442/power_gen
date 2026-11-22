// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
//
// The hardware twin's rig (#257, ADR-0019): index enums and constants for
// cpp/src/twin/ (rig plant, EKF, system identification). TS twin:
// generated/twin-rig.ts.

#pragma once

#include <array>
#include <cstddef>

namespace power_gen::twin {

/// SEG bench rig (physics/devices.json "seg".twin).
struct Rig {
    static constexpr const char* DEVICE = "seg";
    struct X { enum : std::size_t { omega = 0, currentA = 1 }; };
    struct Th { enum : std::size_t { inertia = 0, friction = 1, coilR = 2, coilL = 3, kE = 4 }; };
    struct Y { enum : std::size_t { rpm = 0, current = 1, voltage = 2 }; };
    static constexpr std::size_t STATE_SIZE = 2;
    static constexpr std::size_t PARAM_SIZE = 5;
    static constexpr std::size_t SENSOR_SIZE = 3;

    /// Predict-step substep cap, s (fixed RK4 substeps ≤ H_MAX).
    static constexpr double H_MAX = 0.002;
    /// Board drive: v = V_PER_RPM · RPM_cmd, |v| ≤ V_MAX (RUN only).
    static constexpr double V_PER_RPM = 0.0125;
    static constexpr double V_MAX = 12.0;

    /// Continuous process-noise density per state, unit²/s.
    static constexpr std::array<double, STATE_SIZE> PROCESS_NOISE = { 1.0, 0.0001 };
    static constexpr std::array<double, PARAM_SIZE> PARAM_NOMINAL = { 0.0025, 0.0015, 2.0, 0.08, 0.1 };
    static constexpr std::array<double, PARAM_SIZE> PARAM_MIN = { 0.0001, 0.00001, 0.05, 0.0001, 0.001 };
    static constexpr std::array<double, PARAM_SIZE> PARAM_MAX = { 0.05, 0.05, 50.0, 2.0, 1.0 };
    /// Measurement noise σ per sensor, in its unit.
    static constexpr std::array<double, SENSOR_SIZE> SENSOR_SIGMA = { 2.0, 0.02, 0.05 };

    static constexpr const char* STATE_NAMES[STATE_SIZE] = { "omega", "currentA" };
    static constexpr const char* PARAM_NAMES[PARAM_SIZE] = { "inertia", "friction", "coilR", "coilL", "kE" };
    static constexpr const char* SENSOR_NAMES[SENSOR_SIZE] = { "rpm", "current", "voltage" };
};

} // namespace power_gen::twin

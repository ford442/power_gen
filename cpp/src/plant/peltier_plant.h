#pragma once
// Simplified 1D thermoelectric stack (Seebeck + Peltier + Joule; Thomson
// neglected). Classroom numbers: physics/constants.json → generated/constants.h
// (shared with the TS fallback in devices/core/peltier-mesh.ts).

#include "../../../generated/constants.h"

struct PeltierState {
    // hot/cold both start at ambient; the heater drive opens the gap.
    float hotK{power_gen::PeltierConstants::AMBIENT_K};
    float coldK{power_gen::PeltierConstants::AMBIENT_K};
    float ambientK{power_gen::PeltierConstants::AMBIENT_K};
    float seebeck{power_gen::PeltierConstants::SEEBECK_VK};      // V/K per couple
    float couples{power_gen::PeltierConstants::COUPLES};         // effective S = seebeck*couples
    float rInternalOhm{power_gen::PeltierConstants::R_INTERNAL_OHM};
    float rLoadOhm{power_gen::PeltierConstants::R_LOAD_OHM};     // matched load
    float conductanceWK{power_gen::PeltierConstants::CONDUCTANCE_WK};
    float heatCapHotJK{power_gen::PeltierConstants::HEAT_CAP_HOT_JK};
    float heatCapColdJK{power_gen::PeltierConstants::HEAT_CAP_COLD_JK};
    float sinkWK{power_gen::PeltierConstants::SINK_WK};          // cold side → ambient, W/K
    float heaterMaxW{power_gen::PeltierConstants::HEATER_MAX_W}; // drive=1 heater input, W
    float deltaTRefK{power_gen::PeltierConstants::DELTA_T_REF_K};// typicalDeltaT for normalization
    float deltaTK{0.f};        // derived: hotK − coldK
    float currentA{0.f};       // derived
    float voltageV{0.f};       // derived load voltage
    float powerW{0.f};         // derived electrical output
    float cop{0.f};            // derived P_out / Q_in (generator efficiency)
    float drive{0.f};          // 0..1 heater drive
};

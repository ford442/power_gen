#pragma once
// Simplified 1D thermoelectric stack (Seebeck + Peltier + Joule; Thomson
// neglected). Constants mirror scientific-data.js PELTIER_DATA (Bi₂Te₃).

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

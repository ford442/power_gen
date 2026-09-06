#pragma once
// Coupled-inductor two-winding transformer — Quanta classroom L–M ODE.
// Classroom numbers: physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"

struct TransformerState {
    float i1{0.f};             // primary current, A
    float i2{0.f};             // secondary current, A
    float v1{0.f};             // primary drive voltage, V
    float v2{0.f};             // secondary terminal voltage (−R_load i2), V
    float k{power_gen::TransformerConstants::K_IDEAL};
    float fluxN{0.f};          // normalized flux linkage 0..1
    float phase{0.f};          // rad, ωt
    float fHz{power_gen::TransformerConstants::F_HZ};
    float l1H{power_gen::TransformerConstants::L1_H};
    float l2H{power_gen::TransformerConstants::L2_H};
    float kIdeal{power_gen::TransformerConstants::K_IDEAL};
    float kLeakage{power_gen::TransformerConstants::K_LEAKAGE};
    float r1Ohm{power_gen::TransformerConstants::R1_OHM};
    float r2Ohm{power_gen::TransformerConstants::R2_OHM};
    float rLoadOhm{power_gen::TransformerConstants::R_LOAD_OHM};
    float vPeak{power_gen::TransformerConstants::V_PEAK};
    bool  leakage{false};
    float drive{0.f};
};

#pragma once
// Maglev gap ODE — mirrors the Quanta JS spring–damper
// (devices/quanta/magnetic-levitation.ts). Classroom numbers:
// physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"

struct MaglevState {
    float gap{power_gen::MaglevConstants::GAP_INITIAL_M};        // m
    float gapVel{0.f};                                            // m/s
    float gapMm{power_gen::MaglevConstants::GAP_INITIAL_M * 1000.f};
    float fieldT{0.f};
    float liftN{0.f};
    float rpm{0.f};
    float kSpring{power_gen::MaglevConstants::K_SPRING_NM};
    float cDamp{power_gen::MaglevConstants::C_DAMP_NSM};
    float mass{power_gen::MaglevConstants::MASS_KG};
    float drive{0.f};
};

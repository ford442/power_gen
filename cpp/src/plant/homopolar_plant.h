#pragma once
// Homopolar Faraday disc L–R + back-EMF — mirrors
// devices/quanta/homopolar-generator.ts. Classroom numbers:
// physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"

struct HomopolarState {
    float omega{0.f};          // rad/s
    float angle{0.f};          // rad
    float rpm{0.f};
    float emfV{0.f};
    float currentA{0.f};
    float fieldT{power_gen::HomopolarConstants::B_AXIAL_T};
    float discRadiusM{power_gen::HomopolarConstants::DISC_RADIUS_M};
    float rOhm{power_gen::HomopolarConstants::R_OHM};
    float lHenry{power_gen::HomopolarConstants::L_HENRY};
    float inertia{power_gen::HomopolarConstants::INERTIA_KG_M2};
    float drag{power_gen::HomopolarConstants::DRAG_NMS_PER_RAD};
    float tauDriveMax{power_gen::HomopolarConstants::TAU_DRIVE_MAX_NM};
    float drive{0.f};
};

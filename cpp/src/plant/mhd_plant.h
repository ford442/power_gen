#pragma once
// Hartmann-style MHD channel: pressure-driven conductive flow retarded by
// Lorentz braking, inducing a load voltage V = B·u·w.
// Classroom numbers: physics/constants.json → generated/constants.h
// (shared with the TS fallback in devices/core/mhd-mesh.ts).

#include "../../../generated/constants.h"

struct MHDState {
    float flowU{0.f};          // bulk channel velocity, m/s
    float flowUMax{power_gen::MhdConstants::FLOW_U_MAX_MPS};
    float bFieldT{power_gen::MhdConstants::B_FIELD_BASE_T}; // applied transverse field (drive-scaled)
    float bFieldBaseT{power_gen::MhdConstants::B_FIELD_BASE_T};
    float bFieldSpanT{power_gen::MhdConstants::B_FIELD_SPAN_T};
    float pumpAccel{power_gen::MhdConstants::PUMP_ACCEL_MS2};  // drive=1 pressure-gradient accel, m/s²
    float lorentzK{power_gen::MhdConstants::LORENTZ_K};        // effective σB²/ρ braking, 1/(s·T²)
    float frictionK{power_gen::MhdConstants::FRICTION_K};      // viscous/wall losses, 1/s
    float widthM{power_gen::MhdConstants::WIDTH_M};            // electrode spacing
    float halfGapM{power_gen::MhdConstants::HALF_GAP_M};       // channel half-gap (Hartmann length)
    float sigmaSm{power_gen::MhdConstants::SIGMA_SM};          // conductivity, S/m (liquid-metal-ish)
    float rhoKgM3{power_gen::MhdConstants::RHO_KG_M3};         // working-fluid density
    float nuM2s{power_gen::MhdConstants::NU_M2S};              // kinematic viscosity
    float rLoadOhm{power_gen::MhdConstants::R_LOAD_OHM};
    float rInternalOhm{power_gen::MhdConstants::R_INTERNAL_OHM};
    float hartmann{0.f};       // derived Ha = B·d·sqrt(σ/(ρν))
    float voltageV{0.f};       // derived load voltage
    float currentA{0.f};       // derived
    float powerW{0.f};         // derived electrical output
    float drive{0.f};          // 0..1 pump/field drive
};

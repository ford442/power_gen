#pragma once
// Hartmann-style MHD channel: pressure-driven conductive flow retarded by
// Lorentz braking, inducing a load voltage V = B·u·w.

struct MHDState {
    float flowU{0.f};          // bulk channel velocity, m/s
    float flowUMax{5.f};       // normalization velocity
    float bFieldT{0.2f};       // applied transverse field (drive-scaled)
    float pumpAccel{6.f};      // drive=1 pressure-gradient acceleration, m/s²
    float lorentzK{2.5f};      // effective σB²/ρ braking coefficient, 1/(s·T²)
    float frictionK{0.8f};     // viscous/wall losses, 1/s
    float widthM{0.10f};       // electrode spacing
    float halfGapM{0.05f};     // channel half-gap (Hartmann length)
    float sigmaSm{1.0e6f};     // conductivity, S/m (liquid-metal-ish)
    float rhoKgM3{870.f};      // working-fluid density
    float nuM2s{8.0e-7f};      // kinematic viscosity
    float rLoadOhm{0.05f};
    float rInternalOhm{0.05f};
    float hartmann{0.f};       // derived Ha = B·d·sqrt(σ/(ρν))
    float voltageV{0.f};       // derived load voltage
    float currentA{0.f};       // derived
    float powerW{0.f};         // derived electrical output
    float drive{0.f};          // 0..1 pump/field drive
};

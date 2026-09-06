#pragma once
// Maglev gap ODE — mirrors Quanta JS spring–damper (magnetic-levitation.ts).

struct MaglevState {
    float gap{0.018f};         // m
    float gapVel{0.f};         // m/s
    float gapMm{18.f};
    float fieldT{0.f};
    float liftN{0.f};
    float rpm{0.f};
    float kSpring{180.f};
    float cDamp{14.f};
    float mass{0.045f};
    float drive{0.f};
};

#pragma once
// Heron fountain plant state — Bernoulli / Swamee–Jain (mirrors JS fallback).

struct HeronState {
    float head{0.f};          // m
    float headMax{4.5f};      // m
    float vExit{0.f};         // m/s scene
    float flowLmin{0.f};
    float pressureKPa{0.f};
    float reynolds{0.f};
    float pumpRate{2.2f};
    float drainCoeff{0.30f};
    float pipeLengthM{2.5f};
    float pipeDiameterM{0.012f};
    float dischargeCoeff{0.35f};
    float roughnessM{1.5e-5f};
    float drive{0.f};         // 0..1
};

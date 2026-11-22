#pragma once
// Heron fountain plant state — Bernoulli with a nozzle discharge coefficient
// and Darcy–Weisbach friction in the supply pipe. Same arithmetic as
// computeHeronHydraulics in src/heron-layout.ts; test:golden holds them
// together.
//
// The pipe and nozzle numbers are a layout preset's (src/heron-layout.ts
// PRESET_DEFS). The defaults below are the `classic` preset; the host sends
// the active one with setHeronLayout.

struct HeronState {
    float head{0.f};          // m
    float headMax{4.5f};      // m
    float vExit{0.f};         // m/s at the nozzle
    float flowLmin{0.f};      // nozzle area × vExit
    float pressureKPa{0.f};   // ρ·g·head
    float reynolds{0.f};      // of the supply pipe
    float pumpRate{2.2f};
    float drainCoeff{0.30f};
    float pipeLengthM{4.0f};
    float pipeDiameterM{0.08f};
    float nozzleDiameterM{0.04f};
    float dischargeCoeff{0.35f};
    float roughness{0.02f};   // relative, ε/D
    float drive{0.f};         // 0..1
};

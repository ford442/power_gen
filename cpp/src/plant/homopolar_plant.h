#pragma once
// Homopolar Faraday disc L–R + back-EMF — mirrors homopolar-generator.ts.

struct HomopolarState {
    float omega{0.f};          // rad/s
    float angle{0.f};          // rad
    float rpm{0.f};
    float emfV{0.f};
    float currentA{0.f};
    float fieldT{0.55f};
    float discRadiusM{0.14f};
    float rOhm{0.008f};
    float lHenry{0.0015f};
    float inertia{0.002f};
    float drag{0.0008f};
    float tauDriveMax{0.15f};
    float drive{0.f};
};

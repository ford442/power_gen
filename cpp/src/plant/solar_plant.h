#pragma once
// LED / solar / battery SOC plant state.

struct SolarState {
    float batteryCharge{0.5f}; // 0..1 SOC
    float ledPower{0.f};       // 0..1 drive
    float transmittance{0.04f};
    float opticalEff{0.45f};   // panel optical→electrical
    float ledWallPlug{0.30f};  // electrical→optical
};

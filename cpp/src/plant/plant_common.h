#pragma once
// =============================================================
// plant_common.h  –  small shared helpers used by multiple plant
// translation units (pure refactor extraction from sim_core.cpp;
// no behavior change vs the original anonymous-namespace helpers).
// =============================================================

#include <cmath>
#include <cstdint>

namespace plant_common {

inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// C++17 inline variable: single instance across all translation units,
// matching the original single anonymous-namespace `lcg_state` (only one
// TU — sim_core.cpp — ever existed before the split).
inline uint32_t lcg_state = 0x12345678u;

inline float lcg_rand() {
    lcg_state = lcg_state * 1664525u + 1013904223u;
    return static_cast<float>(lcg_state >> 8) / static_cast<float>(1u << 24);
}

inline int rollerIndexToRing(int idx) {
    if (idx < 12) return 0;
    if (idx < 12 + 22) return 1;
    return 2;
}

inline float hash1(float n) {
    float v = std::sin(n * 78.233f + 12.9898f) * 43758.5453f;
    return v - std::floor(v);
}

inline float rnd(uint32_t idx, float salt, float simClock = 0.f) {
    return hash1(static_cast<float>(idx) * 0.1031f + salt * 1.7f + simClock * 0.37f);
}

/// Swamee–Jain friction factor (approximate) for turbulent pipe flow.
inline float swameeJainF(float Re, float eps, float D) {
    if (Re < 1.f) return 0.05f;
    float a = eps / (3.7f * D);
    float b = 5.74f / std::pow(Re, 0.9f);
    float invSqrt = -2.f * std::log10(a + b);
    float f = 1.f / (invSqrt * invSqrt);
    return clampf(f, 0.008f, 0.1f);
}

} // namespace plant_common

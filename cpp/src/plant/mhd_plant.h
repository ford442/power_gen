#pragma once
// Hartmann MHD duct: pressure-driven conductive flow retarded by Lorentz
// braking, inducing a load voltage V = B·u·w. The plant is the mean speed
// across the gap; the profile is the analytic solution below, and the
// plant's wall friction and braking are derived from it and from the circuit
// (namespace mhd_duct) — nothing in the momentum balance is tuned.
// Numbers: physics/constants.json → generated/constants.h (shared with the
// TS twin, src/physics/mhd-duct.ts).

#include "../../../generated/constants.h"

#include <cmath>

// Fully developed Hartmann flow between insulating walls at y = ±a, field
// along y (Hartmann 1937). eta = y/a in [-1, 1]; velocities in units of the
// mean. Written with decaying exponentials so a large Ha cannot overflow;
// below HARTMANN_SERIES_BELOW the closed form cancels in float and a series in
// Ha² takes over (Ha → 0 is the Poiseuille parabola). The TS twin is
// src/physics/hartmann.ts and the WGSL one passes/particle-compute.wgsl;
// `--mode hartmann` prints this one for scripts/tests/hartmann.test.mjs.
namespace hartmann {

inline constexpr float SERIES_BELOW = 0.25f;

/// cosh(h·e) / cosh(h) for e in [0, 1], h ≥ 0.
inline float cosh_ratio(float h, float e) {
    return std::exp(h * (e - 1.f)) * (1.f + std::exp(-2.f * h * e)) / (1.f + std::exp(-2.f * h));
}

/// u(eta) / u(0): 1 on the centre line, 0 at the walls.
inline float shape(float eta, float ha) {
    const float e = std::fmin(std::fabs(eta), 1.f);
    const float h = std::fabs(ha);
    if (!(h >= SERIES_BELOW)) return (1.f - e * e) * (1.f + h * h * e * e / 12.f);
    const float sech = 2.f * std::exp(-h) / (1.f + std::exp(-2.f * h));
    return (1.f - cosh_ratio(h, e)) / (1.f - sech);
}

/// u(eta) / mean: integrates to 1 across the gap.
inline float profile(float eta, float ha) {
    const float e = std::fmin(std::fabs(eta), 1.f);
    const float h = std::fabs(ha);
    if (!(h >= SERIES_BELOW)) return 1.5f * (1.f - e * e) * (1.f + h * h * (e * e / 12.f - 1.f / 60.f));
    return (1.f - cosh_ratio(h, e)) / (1.f - std::tanh(h) / h);
}

/// Wall shear −(a/Ū)·du/dy at y = a: 3 for Poiseuille, → Ha for thin layers.
inline float wall_shear(float ha) {
    const float h = std::fabs(ha);
    if (!(h >= SERIES_BELOW)) return 3.f * (1.f + h * h / 15.f);
    const float th = std::tanh(h);
    return h * th / (1.f - th / h);
}

} // namespace hartmann

// The drawn duct in device-local render units, and the display slow-down —
// MHD_DUCT / MHD_PARCEL_SLOWDOWN in src/devices/core/mhd-parcels.ts.
namespace mhd_scene {
inline constexpr float X_IN = -2.1f;
inline constexpr float LENGTH_U = 4.2f;
inline constexpr float HALF_GAP_U = 0.42f;
inline constexpr float HALF_WIDTH_U = 0.12f;
inline constexpr float SLOWDOWN = 6.f;
} // namespace mhd_scene

struct MHDState {
    float flowU{0.f};          // bulk channel velocity, m/s
    float flowUMax{power_gen::MhdConstants::FLOW_U_MAX_MPS};
    float bFieldT{power_gen::MhdConstants::B_FIELD_BASE_T}; // applied transverse field (drive-scaled)
    float bFieldBaseT{power_gen::MhdConstants::B_FIELD_BASE_T};
    float bFieldSpanT{power_gen::MhdConstants::B_FIELD_SPAN_T};
    float pumpAccel{power_gen::MhdConstants::PUMP_ACCEL_MS2};  // drive=1 pressure-gradient accel, m/s²
    float widthM{power_gen::MhdConstants::WIDTH_M};            // electrode spacing
    float halfGapM{power_gen::MhdConstants::HALF_GAP_M};       // channel half-gap (Hartmann length)
    float lengthM{power_gen::MhdConstants::LENGTH_M};          // electrode length along the flow
    float sigmaSm{power_gen::MhdConstants::SIGMA_SM};          // conductivity, S/m (liquid-metal-ish)
    float rhoKgM3{power_gen::MhdConstants::RHO_KG_M3};         // working-fluid density
    float nuM2s{power_gen::MhdConstants::NU_M2S};              // kinematic viscosity
    float rLoadOhm{power_gen::MhdConstants::R_LOAD_OHM};
    float hartmann{0.f};       // derived Ha = B·a·sqrt(σ/(ρν))
    float voltageV{0.f};       // derived load voltage
    float currentA{0.f};       // derived
    float powerW{0.f};         // derived electrical output
    float drive{0.f};          // 0..1 pump/field drive
};

// The mean flow's momentum balance, gap-averaged over the Hartmann profile:
//
//   dU/dt = drive·pump − (friction(Ha) + braking(B))·U
//
// Both rates follow from the profile and the circuit; the profile keeps its
// Hartmann shape whatever the load, so they hold at any current.
namespace mhd_duct {

/// Hartmann number, B·a·√(σ/ρν).
inline float hartmann_number(const MHDState& m, float bFieldT) {
    return bFieldT * m.halfGapM * std::sqrt(m.sigmaSm / (m.rhoKgM3 * m.nuM2s));
}

/// The fluid's resistance between the electrodes, w / (σ·2a·L), Ω.
inline float internal_ohm(const MHDState& m) {
    return m.widthM / (m.sigmaSm * 2.f * m.halfGapM * m.lengthM);
}

/// Wall friction, 1/s: the profile's shear on the two Hartmann walls per unit
/// mass of the slot, (ν/a²)·Φ(Ha). 3ν/a² at B = 0 (Poiseuille), ν·Ha/a² for
/// thin Hartmann layers.
inline float friction_rate(const MHDState& m, float ha) {
    return m.nuM2s / (m.halfGapM * m.halfGapM) * hartmann::wall_shear(ha);
}

/// Lorentz braking, 1/s: the force B·I·w on the current the circuit draws,
/// per unit mass between the electrodes — (σB²/ρ)·R_i/(R_i + R_load). Zero
/// on open circuit, σB²/ρ on a short.
inline float braking_rate(const MHDState& m, float bFieldT) {
    const float ri = internal_ohm(m);
    return m.sigmaSm * bFieldT * bFieldT / m.rhoKgM3 * ri / (ri + m.rLoadOhm);
}

} // namespace mhd_duct


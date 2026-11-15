#pragma once
// Homopolar Faraday disc L–R + back-EMF — mirrors
// devices/quanta/homopolar-generator.ts. Classroom numbers:
// physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"
#include "../../../generated/plant-ode.h"

#include <cstddef>
#include <span>

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
    // Adaptive-integrator carry-over (core/integrate.h StepperState).
    float stepH{0.f};
    float stepErrOld{1e-4f};
};

struct HomopolarInput {
    float drive{0.f}; // the plant's own setpoint (not clamped: the TS twin does not)
};

/// sim_core::Plant view over a HomopolarState. x = [omega, currentA].
struct HomopolarPlant {
    using ode = power_gen::ode::Homopolar;
    using input_type = HomopolarInput;
    static constexpr std::size_t state_size = ode::STATE_SIZE;
    static constexpr std::size_t output_size = ode::OUTPUT_SIZE;

    explicit HomopolarPlant(HomopolarState& st) : s(st) {}

    void derivs(double t, std::span<const float> x, const HomopolarInput& u, std::span<float> dxdt) const;
    /// y = [emfV] at x.
    void outputs(std::span<const float> x, const HomopolarInput& u, std::span<float> y) const;
    void save(std::span<float> x) const;
    void load(std::span<const float> x);
    /// ω, I ≥ 0 after every step — the clamp both plants have always applied.
    bool constrain(std::span<float> x) const;

    HomopolarState& s;
};

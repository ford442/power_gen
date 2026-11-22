#pragma once
// =============================================================
// twin/rig_plant.h  –  the hardware twin's rig model (#257, ADR-0019).
//
// physics/devices.json "seg".twin → generated/twin-rig.h. A lumped
// DC-machine equivalent of the commutated coil array and its rotor:
//
//   J·dω/dt = k_e·I − b·ω                 (coil torque − friction)
//   L·dI/dt = v − R·I − k_e·ω             (drive − ohmic drop − back-EMF)
//
//   x = [ω rad/s, I A]   θ = [J, b, R, L, k_e]   u = v (the board's drive, V)
//   y = [ω·30/π RPM, I A, k_e·ω V]           (sensors, catalog order)
//
// It is a sim_core::ParametricPlant (core/plant.h): the right-hand side and
// the measurement model are templates on the scalar, so the estimator gets
// F = ∂x⁺/∂x and H = ∂y/∂x, and system identification ∂y/∂θ, by running the
// same code on core/dual.h Duals. Not the SEG roller plant — the roller
// plant is what the screen draws; this is what the twin believes is on the
// bench. Simulated, not metrology.
// =============================================================

#include "../../../generated/twin-rig.h"
#include "../core/integrate.h"
#include "../core/plant.h"

#include <array>
#include <cmath>
#include <cstddef>
#include <span>

namespace twin {

using Rig = power_gen::twin::Rig;

struct RigInput {
    double vDrive{0.0}; ///< board drive over the interval, V (zero-order hold)
};

struct RigPlant {
    using input_type = RigInput;
    static constexpr std::size_t state_size = Rig::STATE_SIZE;
    static constexpr std::size_t output_size = Rig::SENSOR_SIZE;
    static constexpr std::size_t param_size = Rig::PARAM_SIZE;

    std::array<float, state_size> x{};
    std::array<float, param_size> theta{};

    RigPlant() {
        for (std::size_t i = 0; i < param_size; ++i) theta[i] = static_cast<float>(Rig::PARAM_NOMINAL[i]);
    }

    template <class S>
    void derivs_p(double, std::span<const S> xs, std::span<const S> th, const RigInput& u, std::span<S> dx) const {
        const S w = xs[Rig::X::omega], i = xs[Rig::X::currentA];
        const S J = th[Rig::Th::inertia], b = th[Rig::Th::friction];
        const S R = th[Rig::Th::coilR], L = th[Rig::Th::coilL], k = th[Rig::Th::kE];
        dx[Rig::X::omega] = (k * i - b * w) / J;
        dx[Rig::X::currentA] = (u.vDrive - R * i - k * w) / L;
    }

    template <class S>
    void outputs_p(std::span<const S> xs, std::span<const S> th, const RigInput&, std::span<S> y) const {
        constexpr double kRpmPerRadS = 30.0 / 3.14159265358979323846;
        y[Rig::Y::rpm] = xs[Rig::X::omega] * kRpmPerRadS;
        y[Rig::Y::current] = xs[Rig::X::currentA];
        y[Rig::Y::voltage] = th[Rig::Th::kE] * xs[Rig::X::omega];
    }

    /// DifferentiablePlant: θ is the plant's own, held constant.
    template <class S>
    void derivs_t(double t, std::span<const S> xs, const RigInput& u, std::span<S> dx) const {
        std::array<S, param_size> th{};
        for (std::size_t j = 0; j < param_size; ++j) th[j] = S(theta[j]);
        derivs_p<S>(t, xs, std::span<const S>(th), u, dx);
    }

    // ── sim_core::Plant (float) ────────────────────────────────
    void derivs(double t, std::span<const float> xs, const RigInput& u, std::span<float> dx) const {
        derivs_t<float>(t, xs, u, dx);
    }
    void outputs(std::span<const float> xs, const RigInput& u, std::span<float> y) const {
        std::array<float, param_size> th{};
        for (std::size_t j = 0; j < param_size; ++j) th[j] = theta[j];
        outputs_p<float>(xs, std::span<const float>(th), u, y);
    }
    void save(std::span<float> out) const {
        for (std::size_t j = 0; j < state_size; ++j) out[j] = x[j];
    }
    void load(std::span<const float> in) {
        for (std::size_t j = 0; j < state_size; ++j) x[j] = in[j];
    }
    void params(std::span<float> out) const {
        for (std::size_t j = 0; j < param_size; ++j) out[j] = theta[j];
    }
    void set_params(std::span<const float> in) {
        for (std::size_t j = 0; j < param_size; ++j) theta[j] = in[j];
    }
};

static_assert(sim_core::ParametricPlant<RigPlant>);

/// One classical RK4 step of size h on any scalar — the "bench integrator"
/// of the twin (catalog "rk4"). Run on Duals it propagates the sensitivities
/// of the discrete map: x.d[j] = ∂x/∂(seed j). Same tableau as
/// sim_core::rk4_fixed, in the caller's precision.
template <class P, class S>
inline void rk4_step(const P& p, double t, std::array<S, P::state_size>& x, std::span<const S> th,
                     const typename P::input_type& u, double h) {
    constexpr std::size_t N = P::state_size;
    std::array<S, N> y{}, k1{}, k2{}, k3{}, k4{};
    p.template derivs_p<S>(t, std::span<const S>(x), th, u, std::span<S>(k1));
    for (std::size_t i = 0; i < N; ++i) y[i] = x[i] + (0.5 * h) * k1[i];
    p.template derivs_p<S>(t + 0.5 * h, std::span<const S>(y), th, u, std::span<S>(k2));
    for (std::size_t i = 0; i < N; ++i) y[i] = x[i] + (0.5 * h) * k2[i];
    p.template derivs_p<S>(t + 0.5 * h, std::span<const S>(y), th, u, std::span<S>(k3));
    for (std::size_t i = 0; i < N; ++i) y[i] = x[i] + h * k3[i];
    p.template derivs_p<S>(t + h, std::span<const S>(y), th, u, std::span<S>(k4));
    for (std::size_t i = 0; i < N; ++i) x[i] = x[i] + (h / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
}

/// Advance x over dt in ⌈dt / hMax⌉ equal RK4 substeps (input held).
/// Returns the substep count (0 when dt ≤ 0).
template <class P, class S>
inline int advance(const P& p, double t, std::array<S, P::state_size>& x, std::span<const S> th,
                   const typename P::input_type& u, double dt, double hMax) {
    if (!(dt > 0.0)) return 0;
    const int n = static_cast<int>(std::ceil(dt / hMax - 1e-9));
    const int steps = n < 1 ? 1 : n;
    const double h = dt / steps;
    for (int k = 0; k < steps; ++k) rk4_step(p, t + k * h, x, th, u, h);
    return steps;
}

} // namespace twin

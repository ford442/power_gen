#pragma once
// =============================================================
// core/plant.h  –  the Plant concept the integrators in integrate.h step.
//
// A plant is a small view over one bench's state struct (ThomsonState,
// HomopolarState, …) that exposes its ODE as
//
//     dx/dt = f(t, x, u)        x: state_size floats, u: input_type
//
// plus the glue an integrator needs around it:
//
//   state_size        compile-time length of x (from the generated
//                     power_gen::ode::<Plant>::STATE_SIZE in plant-ode.h)
//   input_type        what is held constant over one advance (zero-order
//                     hold): a drive setpoint, an AC phase origin, …
//   derivs(t,x,u,dx)  the right-hand side. Pure: no writes to the plant.
//   output_size /     derived quantities the telemetry reports (a force, a
//   outputs(x,u,y)    coupling coefficient). Pure.
//   save(x) / load(x) gather the ODE state out of the struct into x, and
//                     scatter it back — the only two places that know the
//                     struct's field names. The index order is the generated
//                     enum, so the C++ and TS plants cannot disagree.
//
// A plant with rigid stops or sign constraints (a ring resting on a core
// shoulder, a current that cannot go negative) is a ConstrainedPlant: the
// integrators call constrain(x) after every accepted step.
//
// Everything is float: the plants store float state, and plantSave /
// plantLoad snapshot float vectors. Time is double, so a long run's clock
// (and an AC drive's phase) does not lose resolution.
// =============================================================

#include "dual.h"

#include <array>
#include <concepts>
#include <cstddef>
#include <span>

namespace sim_core {

template <class P>
concept Plant = requires(const P& cp, P& mp, double t,
                         std::span<const float> x, std::span<float> out,
                         const typename P::input_type& u) {
    typename P::input_type;
    { P::state_size } -> std::convertible_to<std::size_t>;
    { P::output_size } -> std::convertible_to<std::size_t>;
    requires P::state_size > 0;
    { cp.derivs(t, x, u, out) } -> std::same_as<void>;
    { cp.outputs(x, u, out) } -> std::same_as<void>;
    { cp.save(out) } -> std::same_as<void>;
    { mp.load(x) } -> std::same_as<void>;
};

/// A plant with stops / sign constraints, applied after every accepted step.
/// Returns true when it changed x (the integrator must then re-evaluate f
/// instead of reusing a first-same-as-last stage).
template <class P>
concept ConstrainedPlant = Plant<P> && requires(const P& cp, std::span<float> x) {
    { cp.constrain(x) } -> std::same_as<bool>;
};

/// Apply P's constraint if it has one; no-op (false) otherwise.
template <Plant P>
inline bool apply_constraint(const P& p, std::span<float> x) {
    if constexpr (ConstrainedPlant<P>) {
        return p.constrain(x);
    } else {
        (void)p;
        (void)x;
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// Differentiable plants (#257 §1, core/dual.h).
//
// A DifferentiablePlant writes its right-hand side once, as a template on the
// scalar type:
//
//   template <class S>
//   void derivs_t(double t, std::span<const S> x, const input_type& u, std::span<S> dx) const;
//
// and its float `derivs` is `derivs_t<float>` — the same expressions, so the
// goldens do not move. Evaluated on Dual<float, N> seeded with the identity it
// yields f and ∂f/∂x in one pass (jacobian_x below), which is what ros23 uses
// in place of forward differences.
//
// A ParametricPlant also takes its identifiable parameters θ explicitly, in
// the same scalar type as x, so one evaluation can carry ∂f/∂x and ∂f/∂θ:
//
//   static constexpr std::size_t param_size;
//   void params(std::span<float> th) const;          θ as the plant holds it
//   void set_params(std::span<const float> th);
//   template <class S> void derivs_p(double t, std::span<const S> x,
//       std::span<const S> th, const input_type& u, std::span<S> dx) const;
//   template <class S> void outputs_p(std::span<const S> x,
//       std::span<const S> th, const input_type& u, std::span<S> y) const;
//
// The estimator and system identification (cpp/src/twin/) are written against
// ParametricPlant only.
// ─────────────────────────────────────────────────────────────

template <class P>
concept DifferentiablePlant = Plant<P> && requires(const P& cp, double t, const typename P::input_type& u,
                                                   std::span<const Dual<float, P::state_size>> xd,
                                                   std::span<Dual<float, P::state_size>> outd) {
    { cp.derivs_t(t, xd, u, outd) } -> std::same_as<void>;
};

template <class P>
concept ParametricPlant = DifferentiablePlant<P> && requires(const P& cp, P& mp, double t,
                                                             const typename P::input_type& u,
                                                             std::span<float> out, std::span<const float> in,
                                                             std::span<const Dual<double, 1>> xd,
                                                             std::span<Dual<double, 1>> outd) {
    { P::param_size } -> std::convertible_to<std::size_t>;
    requires P::param_size > 0;
    { cp.params(out) } -> std::same_as<void>;
    { mp.set_params(in) } -> std::same_as<void>;
    { cp.derivs_p(t, xd, xd, u, outd) } -> std::same_as<void>;
    { cp.outputs_p(xd, xd, u, outd) } -> std::same_as<void>;
};

/// A plant may write ∂f/∂x out itself: `jacobian(t, x, u, J)`, row-major.
/// Worth it for a large sparse one — a Dual over N states carries N partials
/// through every operation, and for the 28-node Peltier leg that instantiation
/// alone was 11 KB of the release binary for a tridiagonal answer.
/// `--mode ad` holds whichever a plant uses to central differences.
template <class P>
concept AnalyticJacobianPlant = Plant<P> && requires(const P& cp, double t, const typename P::input_type& u,
                                                     std::span<const float> x, std::span<float> J) {
    { cp.jacobian(t, x, u, J) } -> std::same_as<void>;
};

/// f(t, x, u) and J = ∂f/∂x (row-major, J[i·N + j] = ∂f_i/∂x_j): the plant's
/// own `jacobian` when it has one, else one Dual evaluation. Float in, float
/// out — the precision the integrators run at.
template <DifferentiablePlant P>
inline void jacobian_x(const P& p, double t, std::span<const float> x, const typename P::input_type& u,
                       std::span<float> f, std::span<float> J) {
    constexpr std::size_t N = P::state_size;
    if constexpr (AnalyticJacobianPlant<P>) {
        p.derivs(t, x, u, f);
        p.jacobian(t, x, u, J);
        return;
    }
    using D = Dual<float, N>;
    std::array<D, N> xd{}, fd{};
    for (std::size_t j = 0; j < N; ++j) xd[j] = D::variable(x[j], j);
    p.derivs_t(t, std::span<const D>(xd), u, std::span<D>(fd));
    for (std::size_t i = 0; i < N; ++i) {
        f[i] = fd[i].v;
        for (std::size_t j = 0; j < N; ++j) J[i * N + j] = fd[i].d[j];
    }
}

} // namespace sim_core

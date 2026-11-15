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

} // namespace sim_core

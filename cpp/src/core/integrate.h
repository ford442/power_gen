#pragma once
// =============================================================
// core/integrate.h  –  ODE integrators for the Plant concept (plant.h).
//
//   euler_fixed    one explicit Euler step (homopolar's historical scheme)
//   rk4_fixed      one classical RK4 step — the arithmetic the hand-written
//                  plants used, term for term, so porting a plant onto it is
//                  bit-identical (test:golden / test:snapshots do not move)
//   dopri5_advance adaptive Dormand–Prince 5(4), PI step control, dense
//                  output: the last step of a frame runs past the frame end
//                  and the frame-end state is interpolated, so a frame
//                  boundary never forces a short step
//   ros23_advance  Shampine's L-stable Rosenbrock (2,3) pair (MATLAB ode23s)
//                  for loops too stiff for an explicit method. J = ∂f/∂x is
//                  exact (core/dual.h) for a DifferentiablePlant, forward
//                  differences otherwise
//
// Mirror: src/renderers/shared/integrate.ts (same algorithms, same constants;
// test:golden holds the two to each other per integrator).
//
// Adaptive steppers carry only StepperState {h, errOld} between frames, so a
// plant snapshot holds two extra floats and a restored plant steps on
// bit-identically. No allocation: every work array is a std::array sized by
// P::state_size.
// =============================================================

#include "plant.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>

namespace sim_core {

/// Catalog `integrator` values (physics/devices.json → generated/plant-ode.h).
enum class Integrator : int { Euler = 0, Rk4 = 1, Dopri5 = 2, Ros23 = 3 };

inline const char* integrator_name(Integrator m) {
    switch (m) {
        case Integrator::Euler: return "euler";
        case Integrator::Rk4: return "rk4";
        case Integrator::Dopri5: return "dopri5";
        case Integrator::Ros23: return "ros23";
    }
    return "?";
}

/// Work done by one advance (or one fixed step). `ok` false = a non-finite
/// state, a step size underflow or the step cap; x then holds the last good
/// state.
struct StepStats {
    std::uint32_t rhs{0};      ///< right-hand-side evaluations
    std::uint32_t steps{0};    ///< accepted steps
    std::uint32_t rejected{0}; ///< rejected steps (adaptive only)
    std::uint32_t jacobians{0};///< Jacobian builds (ros23 only)
    bool ok{true};

    StepStats& operator+=(const StepStats& o) {
        rhs += o.rhs; steps += o.steps; rejected += o.rejected; jacobians += o.jacobians;
        ok = ok && o.ok;
        return *this;
    }
};

/// What an adaptive stepper keeps between frames (and in a snapshot).
/// h ≤ 0 means "no history": the next advance picks a starting step.
struct StepperState {
    float h{0.f};
    float errOld{1e-4f};
};

/// Mixed error tolerance: |e_i| ≤ atol_i + rtol·max(|x_i|, |x_new,i|).
template <std::size_t N>
struct Tolerance {
    float rtol{1e-4f};
    std::array<float, N> atol{};
    /// Largest step, s (∞ = none).
    double hMax{std::numeric_limits<double>::infinity()};
    /// Accepted-step cap per advance (a runaway guard, not a budget).
    std::uint32_t maxSteps{200000};
};

namespace detail {

template <std::size_t N>
using Vec = std::array<float, N>;

template <std::size_t N>
inline bool all_finite(const Vec<N>& v) {
    for (float a : v) {
        if (!std::isfinite(a)) return false;
    }
    return true;
}

/// RMS of e_i / (atol_i + rtol·max(|a_i|, |b_i|)).
template <std::size_t N>
inline float err_norm(const Vec<N>& e, const Vec<N>& a, const Vec<N>& b, const Tolerance<N>& tol) {
    float acc = 0.f;
    for (std::size_t i = 0; i < N; ++i) {
        const float sc = tol.atol[i] + tol.rtol * std::max(std::fabs(a[i]), std::fabs(b[i]));
        const float r = e[i] / sc;
        acc += r * r;
    }
    return std::sqrt(acc / static_cast<float>(N));
}

template <Plant P>
inline void f(const P& p, double t, const Vec<P::state_size>& x,
              const typename P::input_type& u, Vec<P::state_size>& dx, StepStats& s) {
    p.derivs(t, std::span<const float>(x), u, std::span<float>(dx));
    ++s.rhs;
}

} // namespace detail

// ─────────────────────────────────────────────────────────────
// Fixed-step methods: one step of size h from time t. x is committed even
// when it went non-finite for Euler (the plant's own clamps decide, as they
// always did); RK4 leaves x at the last finite state and reports !ok.
// ─────────────────────────────────────────────────────────────

template <Plant P>
StepStats euler_fixed(const P& p, double t, float h, std::span<float> x,
                      const typename P::input_type& u) {
    constexpr std::size_t N = P::state_size;
    StepStats s;
    detail::Vec<N> y{}, k{};
    std::copy_n(x.begin(), N, y.begin());
    detail::f(p, t, y, u, k, s);
    for (std::size_t i = 0; i < N; ++i) y[i] = y[i] + h * k[i];
    apply_constraint(p, std::span<float>(y));
    std::copy_n(y.begin(), N, x.begin());
    s.steps = 1;
    s.ok = detail::all_finite<N>(y);
    return s;
}

/// Stage times t, t + h/2, t + h/2, t + h (double); stage states in float as
///   y2 = x + (0.5f·h)·k1, y3 = x + (0.5f·h)·k2, y4 = x + h·k3,
///   x' = x + (h/6)·(((k1 + 2k2) + 2k3) + k4)
/// — exactly the expression order of the plants this replaced.
template <Plant P>
StepStats rk4_fixed(const P& p, double t, float h, std::span<float> x,
                    const typename P::input_type& u) {
    constexpr std::size_t N = P::state_size;
    StepStats s;
    detail::Vec<N> x0{}, y{}, k1{}, k2{}, k3{}, k4{};
    std::copy_n(x.begin(), N, x0.begin());
    const double hd = static_cast<double>(h);
    const double tm = t + 0.5 * hd;
    detail::f(p, t, x0, u, k1, s);
    for (std::size_t i = 0; i < N; ++i) y[i] = x0[i] + 0.5f * h * k1[i];
    detail::f(p, tm, y, u, k2, s);
    for (std::size_t i = 0; i < N; ++i) y[i] = x0[i] + 0.5f * h * k2[i];
    detail::f(p, tm, y, u, k3, s);
    for (std::size_t i = 0; i < N; ++i) y[i] = x0[i] + h * k3[i];
    detail::f(p, t + hd, y, u, k4, s);
    const float sixth = h / 6.f;
    for (std::size_t i = 0; i < N; ++i) {
        y[i] = x0[i] + sixth * (k1[i] + 2.f * k2[i] + 2.f * k3[i] + k4[i]);
    }
    if (!detail::all_finite<N>(y)) {
        s.ok = false;
        return s;
    }
    apply_constraint(p, std::span<float>(y));
    std::copy_n(y.begin(), N, x.begin());
    s.steps = 1;
    return s;
}

// ─────────────────────────────────────────────────────────────
// Dormand–Prince 5(4) — coefficients and dense output as in Hairer, Nørsett
// & Wanner, "Solving ODEs I", §II.5 / §II.6 (DOPRI5 / CONTD5).
// ─────────────────────────────────────────────────────────────
namespace dp5 {
inline constexpr float c2 = 0.2f, c3 = 0.3f, c4 = 0.8f, c5 = 8.f / 9.f;
inline constexpr float a21 = 0.2f;
inline constexpr float a31 = 3.f / 40.f, a32 = 9.f / 40.f;
inline constexpr float a41 = 44.f / 45.f, a42 = -56.f / 15.f, a43 = 32.f / 9.f;
inline constexpr float a51 = 19372.f / 6561.f, a52 = -25360.f / 2187.f, a53 = 64448.f / 6561.f,
                       a54 = -212.f / 729.f;
inline constexpr float a61 = 9017.f / 3168.f, a62 = -355.f / 33.f, a63 = 46732.f / 5247.f,
                       a64 = 49.f / 176.f, a65 = -5103.f / 18656.f;
inline constexpr float a71 = 35.f / 384.f, a73 = 500.f / 1113.f, a74 = 125.f / 192.f,
                       a75 = -2187.f / 6784.f, a76 = 11.f / 84.f;
inline constexpr float e1 = 71.f / 57600.f, e3 = -71.f / 16695.f, e4 = 71.f / 1920.f,
                       e5 = -17253.f / 339200.f, e6 = 22.f / 525.f, e7 = -1.f / 40.f;
inline constexpr float d1 = -12715105075.f / 11282082432.f, d3 = 87487479700.f / 32700410799.f,
                       d4 = -10690763975.f / 1880347072.f, d5 = 701980252875.f / 199316789632.f,
                       d6 = -1453857185.f / 822651844.f, d7 = 69997945.f / 29380423.f;
// Step control (DOPRI5 defaults): fac ∈ [0.2, 10], safety 0.9, PI β = 0.04.
inline constexpr float kSafe = 0.9f, kFacMin = 0.2f, kFacMax = 10.f, kBeta = 0.04f;
inline constexpr float kExpo1 = 0.2f - kBeta * 0.75f;
} // namespace dp5

/// Hairer's starting step (HINIT): one explicit Euler probe, two RHS.
template <Plant P>
float initial_step(const P& p, const detail::Vec<P::state_size>& x, const detail::Vec<P::state_size>& k1,
                   const typename P::input_type& u, const Tolerance<P::state_size>& tol, int order,
                   double hMax, StepStats& s) {
    constexpr std::size_t N = P::state_size;
    float dnf = 0.f, dny = 0.f;
    for (std::size_t i = 0; i < N; ++i) {
        const float sk = tol.atol[i] + tol.rtol * std::fabs(x[i]);
        dnf += (k1[i] / sk) * (k1[i] / sk);
        dny += (x[i] / sk) * (x[i] / sk);
    }
    float h = (dnf <= 1e-10f || dny <= 1e-10f) ? 1e-6f : 0.01f * std::sqrt(dny / dnf);
    h = std::min(h, static_cast<float>(std::min(hMax, 1e30)));
    detail::Vec<N> y{}, k2{};
    for (std::size_t i = 0; i < N; ++i) y[i] = x[i] + h * k1[i];
    detail::f(p, static_cast<double>(h), y, u, k2, s);
    float der2 = 0.f;
    for (std::size_t i = 0; i < N; ++i) {
        const float sk = tol.atol[i] + tol.rtol * std::fabs(x[i]);
        const float d = (k2[i] - k1[i]) / sk;
        der2 += d * d;
    }
    der2 = std::sqrt(der2) / h;
    const float der12 = std::max(std::fabs(der2), std::sqrt(dnf));
    const float h1 = der12 <= 1e-15f
        ? std::max(1e-6f, std::fabs(h) * 1e-3f)
        : std::pow(0.01f / der12, 1.f / static_cast<float>(order));
    return std::min({100.f * std::fabs(h), h1, static_cast<float>(std::min(hMax, 1e30))});
}

/// Advance x from t = 0 to t = dt. On return x is the state at dt — the
/// dense-output interpolant of the step that crossed dt, constrained — and
/// st holds the step size the controller wants next.
template <Plant P>
StepStats dopri5_advance(const P& p, std::span<float> x, const typename P::input_type& u,
                         double dt, const Tolerance<P::state_size>& tol, StepperState& st) {
    using namespace dp5;
    constexpr std::size_t N = P::state_size;
    StepStats s;
    if (!(dt > 0.0)) return s;
    detail::Vec<N> y{}, yn{}, y6{}, k1{}, k2{}, k3{}, k4{}, k5{}, k6{}, k7{}, ys{}, e{};
    std::copy_n(x.begin(), N, y.begin());
    detail::f(p, 0.0, y, u, k1, s);
    float h = st.h;
    if (!(h > 0.f) || !std::isfinite(h)) h = initial_step(p, y, k1, u, tol, 5, tol.hMax, s);
    float errOld = st.errOld > 0.f ? st.errOld : 1e-4f;
    bool lastRejected = false;
    double t = 0.0;
    const float hMinRel = 16.f * std::numeric_limits<float>::epsilon();

    while (true) {
        if (s.steps >= tol.maxSteps) { s.ok = false; break; }
        const float hh = static_cast<float>(std::min(static_cast<double>(h), tol.hMax));
        if (!(hh > hMinRel * static_cast<float>(std::max(t, dt)))) { s.ok = false; break; }
        const double td = t, hd = static_cast<double>(hh);
        for (std::size_t i = 0; i < N; ++i) ys[i] = y[i] + hh * (a21 * k1[i]);
        detail::f(p, td + c2 * hd, ys, u, k2, s);
        for (std::size_t i = 0; i < N; ++i) ys[i] = y[i] + hh * (a31 * k1[i] + a32 * k2[i]);
        detail::f(p, td + c3 * hd, ys, u, k3, s);
        for (std::size_t i = 0; i < N; ++i) ys[i] = y[i] + hh * (a41 * k1[i] + a42 * k2[i] + a43 * k3[i]);
        detail::f(p, td + c4 * hd, ys, u, k4, s);
        for (std::size_t i = 0; i < N; ++i) {
            ys[i] = y[i] + hh * (a51 * k1[i] + a52 * k2[i] + a53 * k3[i] + a54 * k4[i]);
        }
        detail::f(p, td + c5 * hd, ys, u, k5, s);
        for (std::size_t i = 0; i < N; ++i) {
            y6[i] = y[i] + hh * (a61 * k1[i] + a62 * k2[i] + a63 * k3[i] + a64 * k4[i] + a65 * k5[i]);
        }
        detail::f(p, td + hd, y6, u, k6, s);
        for (std::size_t i = 0; i < N; ++i) {
            yn[i] = y[i] + hh * (a71 * k1[i] + a73 * k3[i] + a74 * k4[i] + a75 * k5[i] + a76 * k6[i]);
        }
        detail::f(p, td + hd, yn, u, k7, s);
        for (std::size_t i = 0; i < N; ++i) {
            e[i] = hh * (e1 * k1[i] + e3 * k3[i] + e4 * k4[i] + e5 * k5[i] + e6 * k6[i] + e7 * k7[i]);
        }
        const bool finite = detail::all_finite<N>(yn) && detail::all_finite<N>(e);
        const float err = finite ? detail::err_norm<N>(e, y, yn, tol) : std::numeric_limits<float>::infinity();

        if (err <= 1.f) {
            // Accepted. PI controller (Gustafsson), DOPRI5 form.
            const float fac11 = std::pow(std::max(err, 1e-10f), kExpo1);
            float fac = fac11 / std::pow(errOld, kBeta);
            fac = std::clamp(fac / kSafe, 1.f / kFacMax, 1.f / kFacMin);
            float hNew = hh / fac;
            if (lastRejected) hNew = std::min(hNew, hh);
            errOld = std::max(err, 1e-4f);
            lastRejected = false;
            ++s.steps;

            if (t + hd >= dt) {
                // Dense output (CONTD5) at θ = (dt − t) / h. The step's own
                // end state is dropped: the next frame starts from what the
                // plant shows, so a snapshot of it is the whole story.
                const float theta = static_cast<float>((dt - t) / hd);
                const float theta1 = 1.f - theta;
                for (std::size_t i = 0; i < N; ++i) {
                    const float ydiff = yn[i] - y[i];
                    const float bspl = hh * k1[i] - ydiff;
                    const float r4 = ydiff - hh * k7[i] - bspl;
                    const float r5 = hh * (d1 * k1[i] + d3 * k3[i] + d4 * k4[i] + d5 * k5[i]
                                           + d6 * k6[i] + d7 * k7[i]);
                    ys[i] = y[i] + theta * (ydiff + theta1 * (bspl + theta * (r4 + theta1 * r5)));
                }
                apply_constraint(p, std::span<float>(ys));
                if (detail::all_finite<N>(ys)) y = ys;
                else s.ok = false;
                h = hNew;
                break;
            }
            t += hd;
            y = yn;
            if (apply_constraint(p, std::span<float>(y))) detail::f(p, t, y, u, k1, s);
            else k1 = k7;
            h = hNew;
        } else {
            ++s.rejected;
            lastRejected = true;
            const float fac11 = finite ? std::pow(err, kExpo1) : 1.f / kFacMin;
            h = hh / std::min(1.f / kFacMin, fac11 / kSafe);
        }
    }
    std::copy_n(y.begin(), N, x.begin());
    st.h = h;
    st.errOld = errOld;
    return s;
}

// ─────────────────────────────────────────────────────────────
// Rosenbrock (2,3) — Shampine & Reichelt, "The MATLAB ODE Suite" (1997),
// the ode23s pair. L-stable second-order step, third-order error estimate,
// first-same-as-last F2, and its own interpolant. J = ∂f/∂x comes from one
// Dual evaluation when the plant is a DifferentiablePlant (core/plant.h) and
// from forward differences (state_size RHS) otherwise; T = ∂f/∂t is always a
// forward difference (1 RHS). The TS mirror differences both, so test:golden
// holds the two at its ros23 ε, not bit for bit.
// ─────────────────────────────────────────────────────────────
namespace ros {
inline constexpr float kD = 0.29289321881345247560f; // 1 / (2 + √2)
inline constexpr float kE32 = 7.41421356237309504880f; // 6 + √2
inline constexpr float kSafe = 0.9f, kFacMin = 0.2f, kFacMax = 5.f;
} // namespace ros

namespace detail {

/// In-place LU with partial pivoting of the row-major N×N matrix a. False if
/// singular.
template <std::size_t N>
inline bool lu_factor(std::array<float, N * N>& a, std::array<std::size_t, N>& piv) {
    for (std::size_t k = 0; k < N; ++k) {
        std::size_t p = k;
        float best = std::fabs(a[k * N + k]);
        for (std::size_t r = k + 1; r < N; ++r) {
            const float v = std::fabs(a[r * N + k]);
            if (v > best) { best = v; p = r; }
        }
        if (!(best > 0.f) || !std::isfinite(best)) return false;
        piv[k] = p;
        if (p != k) {
            for (std::size_t c = 0; c < N; ++c) std::swap(a[k * N + c], a[p * N + c]);
        }
        const float inv = 1.f / a[k * N + k];
        for (std::size_t r = k + 1; r < N; ++r) {
            const float m = a[r * N + k] * inv;
            a[r * N + k] = m;
            for (std::size_t c = k + 1; c < N; ++c) a[r * N + c] -= m * a[k * N + c];
        }
    }
    return true;
}

template <std::size_t N>
inline void lu_solve(const std::array<float, N * N>& a, const std::array<std::size_t, N>& piv, Vec<N>& b) {
    for (std::size_t k = 0; k < N; ++k) {
        if (piv[k] != k) std::swap(b[k], b[piv[k]]);
        for (std::size_t r = k + 1; r < N; ++r) b[r] -= a[r * N + k] * b[k];
    }
    for (std::size_t k = N; k-- > 0;) {
        for (std::size_t c = k + 1; c < N; ++c) b[k] -= a[k * N + c] * b[c];
        b[k] /= a[k * N + k];
    }
}

} // namespace detail

template <Plant P>
StepStats ros23_advance(const P& p, std::span<float> x, const typename P::input_type& u,
                        double dt, const Tolerance<P::state_size>& tol, StepperState& st) {
    using namespace ros;
    constexpr std::size_t N = P::state_size;
    StepStats s;
    if (!(dt > 0.0)) return s;
    detail::Vec<N> y{}, yn{}, ys{}, f0{}, f1{}, f2{}, fT{}, k1{}, k2{}, k3{}, e{}, T{};
    std::array<float, N * N> W{};
    std::array<std::size_t, N> piv{};
    std::copy_n(x.begin(), N, y.begin());
    detail::f(p, 0.0, y, u, f0, s);
    float h = st.h;
    if (!(h > 0.f) || !std::isfinite(h)) h = initial_step(p, y, f0, u, tol, 3, tol.hMax, s);
    float errOld = st.errOld;
    double t = 0.0;
    const float sqrtEps = std::sqrt(std::numeric_limits<float>::epsilon());
    const float hMinRel = 16.f * std::numeric_limits<float>::epsilon();
    bool jacFresh = false;
    std::array<float, N * N> J{};

    while (true) {
        if (s.steps >= tol.maxSteps) { s.ok = false; break; }
        const float hh = static_cast<float>(std::min(static_cast<double>(h), tol.hMax));
        if (!(hh > hMinRel * static_cast<float>(std::max(t, dt)))) { s.ok = false; break; }
        const double hd = static_cast<double>(hh);
        if (!jacFresh) {
            if constexpr (DifferentiablePlant<P>) {
                // J = ∂f/∂x exactly, from one Dual evaluation (core/dual.h) —
                // #257 §1. Its f is f0 again, so it is not counted as an RHS.
                jacobian_x(p, t, std::span<const float>(y), u, std::span<float>(fT), std::span<float>(J));
            } else {
                // Forward-difference J (column j: perturb x_j).
                for (std::size_t j = 0; j < N; ++j) {
                    const float dj = sqrtEps * std::max(std::fabs(y[j]), tol.atol[j] / std::max(tol.rtol, 1e-12f));
                    ys = y;
                    ys[j] += dj;
                    const float dActual = ys[j] - y[j];
                    detail::f(p, t, ys, u, fT, s);
                    for (std::size_t i = 0; i < N; ++i) J[i * N + j] = (fT[i] - f0[i]) / dActual;
                }
            }
            // T = ∂f/∂t stays a forward difference: time is not a Dual (the
            // plants take it as double so an AC phase does not drift).
            const double dtT = static_cast<double>(sqrtEps) * std::max(std::fabs(t), dt);
            detail::f(p, t + dtT, y, u, fT, s);
            for (std::size_t i = 0; i < N; ++i) T[i] = static_cast<float>((fT[i] - f0[i]) / dtT);
            ++s.jacobians;
            jacFresh = true;
        }
        const float hdd = hh * kD;
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = 0; j < N; ++j) W[i * N + j] = (i == j ? 1.f : 0.f) - hdd * J[i * N + j];
        }
        bool finite = detail::lu_factor<N>(W, piv);
        float err = std::numeric_limits<float>::infinity();
        if (finite) {
            for (std::size_t i = 0; i < N; ++i) k1[i] = f0[i] + hdd * T[i];
            detail::lu_solve<N>(W, piv, k1);
            for (std::size_t i = 0; i < N; ++i) ys[i] = y[i] + 0.5f * hh * k1[i];
            detail::f(p, t + 0.5 * hd, ys, u, f1, s);
            for (std::size_t i = 0; i < N; ++i) k2[i] = f1[i] - k1[i];
            detail::lu_solve<N>(W, piv, k2);
            for (std::size_t i = 0; i < N; ++i) {
                k2[i] += k1[i];
                yn[i] = y[i] + hh * k2[i];
            }
            detail::f(p, t + hd, yn, u, f2, s);
            for (std::size_t i = 0; i < N; ++i) {
                k3[i] = f2[i] - kE32 * (k2[i] - f1[i]) - 2.f * (k1[i] - f0[i]) + hdd * T[i];
            }
            detail::lu_solve<N>(W, piv, k3);
            for (std::size_t i = 0; i < N; ++i) e[i] = (hh / 6.f) * (k1[i] - 2.f * k2[i] + k3[i]);
            finite = detail::all_finite<N>(yn) && detail::all_finite<N>(e);
            if (finite) err = detail::err_norm<N>(e, y, yn, tol);
        }

        if (err <= 1.f) {
            float fac = std::pow(std::max(err, 1e-10f), 1.f / 3.f) / kSafe;
            fac = std::clamp(fac, 1.f / kFacMax, 1.f / kFacMin);
            const float hNew = hh / fac;
            errOld = std::max(err, 1e-4f);
            ++s.steps;
            if (t + hd >= dt) {
                // ode23s interpolant: y(t + θh) = y + h·[θ(1−θ)/(1−2d)·k1 + θ(θ−2d)/(1−2d)·k2].
                const float th = static_cast<float>((dt - t) / hd);
                const float inv = 1.f / (1.f - 2.f * kD);
                const float w1 = th * (1.f - th) * inv, w2 = th * (th - 2.f * kD) * inv;
                for (std::size_t i = 0; i < N; ++i) ys[i] = y[i] + hh * (w1 * k1[i] + w2 * k2[i]);
                apply_constraint(p, std::span<float>(ys));
                if (detail::all_finite<N>(ys)) y = ys;
                else s.ok = false;
                h = hNew;
                break;
            }
            t += hd;
            y = yn;
            if (apply_constraint(p, std::span<float>(y))) detail::f(p, t, y, u, f0, s);
            else f0 = f2;
            jacFresh = false;
            h = hNew;
        } else {
            ++s.rejected;
            const float fac = finite ? std::pow(err, 1.f / 3.f) / kSafe : 1.f / kFacMin;
            h = hh / std::min(1.f / kFacMin, fac);
            // J at y is still valid; only W changes with h.
        }
    }
    std::copy_n(y.begin(), N, x.begin());
    st.h = h;
    st.errOld = errOld;
    return s;
}

/// Run one adaptive method over [0, dt]. Fixed methods are the plant's own
/// substep policy and are not dispatched here.
template <Plant P>
StepStats advance_adaptive(Integrator m, const P& p, std::span<float> x, const typename P::input_type& u,
                           double dt, const Tolerance<P::state_size>& tol, StepperState& st) {
    return m == Integrator::Ros23 ? ros23_advance(p, x, u, dt, tol, st)
                                  : dopri5_advance(p, x, u, dt, tol, st);
}

} // namespace sim_core

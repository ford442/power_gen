#pragma once
// =============================================================
// core/dual.h  –  forward-mode automatic differentiation (#257 §1).
//
//   Dual<T, N>   a value v and N directional derivatives d[0..N), T = float
//                or double. Arithmetic and the elementary functions below
//                apply the chain rule, so evaluating a plant's templated RHS
//                (core/plant.h DifferentiablePlant) on Duals seeded with the
//                identity gives f and its Jacobian in one pass:
//
//                  x_j = Dual::variable(x_j, j)   →   f_i.d[j] = ∂f_i/∂x_j
//
// No allocation, no exceptions, no virtuals: a Dual is a std::array plus a
// scalar, so the compiler keeps the whole thing in registers for small N.
// Mixed arithmetic with any arithmetic scalar (a plant's float parameters
// against a double Dual) promotes the scalar to T.
//
// Branches in a plant compare values (`x < 0`), which is how AD treats a
// piecewise function: the derivative of the branch that was taken. A clamp
// therefore has derivative 0 outside its range — the honest answer, and the
// one the central-difference check in `--mode ad` sees too.
//
// Use unqualified calls (`using std::exp; exp(x)`) in templated plant code so
// a float argument picks std::exp(float) exactly as before (bit-identical
// goldens) and a Dual picks the overload here by ADL.
// =============================================================

#include <array>
#include <cmath>
#include <cstddef>
#include <type_traits>

namespace sim_core {

template <class T, std::size_t N>
struct Dual {
    static_assert(std::is_floating_point_v<T>, "Dual<T, N>: T is float or double");
    using value_type = T;
    static constexpr std::size_t size = N;

    T v{};
    std::array<T, N> d{};

    constexpr Dual() = default;
    /// A constant: zero derivative in every direction.
    template <class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0>
    constexpr Dual(U value) : v(static_cast<T>(value)) {} // NOLINT(google-explicit-constructor)

    /// The independent variable for direction i (d = e_i).
    static constexpr Dual variable(T value, std::size_t i) {
        Dual r(value);
        if (i < N) r.d[i] = T(1);
        return r;
    }

    constexpr Dual& operator+=(const Dual& o) {
        v += o.v;
        for (std::size_t i = 0; i < N; ++i) d[i] += o.d[i];
        return *this;
    }
    constexpr Dual& operator-=(const Dual& o) {
        v -= o.v;
        for (std::size_t i = 0; i < N; ++i) d[i] -= o.d[i];
        return *this;
    }
    constexpr Dual& operator*=(const Dual& o) {
        for (std::size_t i = 0; i < N; ++i) d[i] = d[i] * o.v + v * o.d[i];
        v *= o.v;
        return *this;
    }
    constexpr Dual& operator/=(const Dual& o) {
        const T inv = T(1) / o.v;
        const T q = v * inv;
        for (std::size_t i = 0; i < N; ++i) d[i] = (d[i] - q * o.d[i]) * inv;
        v = q;
        return *this;
    }
};

template <class X>
struct is_dual : std::false_type {};
template <class T, std::size_t N>
struct is_dual<Dual<T, N>> : std::true_type {};
template <class X>
inline constexpr bool is_dual_v = is_dual<std::remove_cv_t<std::remove_reference_t<X>>>::value;

/// The value of a scalar or a Dual (for branches, printing, NaN checks).
template <class X>
constexpr auto value_of(const X& x) {
    if constexpr (is_dual_v<X>) return x.v;
    else return x;
}

// ── arithmetic ────────────────────────────────────────────────

template <class T, std::size_t N>
constexpr Dual<T, N> operator+(const Dual<T, N>& a) { return a; }
template <class T, std::size_t N>
constexpr Dual<T, N> operator-(const Dual<T, N>& a) {
    Dual<T, N> r;
    r.v = -a.v;
    for (std::size_t i = 0; i < N; ++i) r.d[i] = -a.d[i];
    return r;
}

template <class T, std::size_t N>
constexpr Dual<T, N> operator+(Dual<T, N> a, const Dual<T, N>& b) { return a += b; }
template <class T, std::size_t N>
constexpr Dual<T, N> operator-(Dual<T, N> a, const Dual<T, N>& b) { return a -= b; }
template <class T, std::size_t N>
constexpr Dual<T, N> operator*(Dual<T, N> a, const Dual<T, N>& b) { return a *= b; }
template <class T, std::size_t N>
constexpr Dual<T, N> operator/(Dual<T, N> a, const Dual<T, N>& b) { return a /= b; }

#define SIM_CORE_DUAL_SCALAR_OPS(OP)                                                           \
    template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0> \
    constexpr Dual<T, N> operator OP(const Dual<T, N>& a, U b) { return a OP Dual<T, N>(b); }   \
    template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0> \
    constexpr Dual<T, N> operator OP(U a, const Dual<T, N>& b) { return Dual<T, N>(a) OP b; }
SIM_CORE_DUAL_SCALAR_OPS(+)
SIM_CORE_DUAL_SCALAR_OPS(-)
SIM_CORE_DUAL_SCALAR_OPS(/)
#undef SIM_CORE_DUAL_SCALAR_OPS

// Scalar × Dual skips the product rule's zero half.
template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0>
constexpr Dual<T, N> operator*(Dual<T, N> a, U b) {
    const T s = static_cast<T>(b);
    a.v *= s;
    for (std::size_t i = 0; i < N; ++i) a.d[i] *= s;
    return a;
}
template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0>
constexpr Dual<T, N> operator*(U a, const Dual<T, N>& b) { return b * a; }

// ── comparisons (on the value) ───────────────────────────────

#define SIM_CORE_DUAL_CMP(OP)                                                                   \
    template <class T, std::size_t N>                                                           \
    constexpr bool operator OP(const Dual<T, N>& a, const Dual<T, N>& b) { return a.v OP b.v; } \
    template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0> \
    constexpr bool operator OP(const Dual<T, N>& a, U b) { return a.v OP static_cast<T>(b); }   \
    template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0> \
    constexpr bool operator OP(U a, const Dual<T, N>& b) { return static_cast<T>(a) OP b.v; }
SIM_CORE_DUAL_CMP(<)
SIM_CORE_DUAL_CMP(>)
SIM_CORE_DUAL_CMP(<=)
SIM_CORE_DUAL_CMP(>=)
SIM_CORE_DUAL_CMP(==)
SIM_CORE_DUAL_CMP(!=)
#undef SIM_CORE_DUAL_CMP

// ── elementary functions: f(a) with f'(a)·a.d ───────────────

namespace detail {
template <class T, std::size_t N>
constexpr Dual<T, N> chain(const Dual<T, N>& a, T fv, T dfv) {
    Dual<T, N> r;
    r.v = fv;
    for (std::size_t i = 0; i < N; ++i) r.d[i] = dfv * a.d[i];
    return r;
}
} // namespace detail

template <class T, std::size_t N>
inline Dual<T, N> sqrt(const Dual<T, N>& a) {
    const T s = std::sqrt(a.v);
    return detail::chain(a, s, s > T(0) ? T(0.5) / s : T(0));
}
template <class T, std::size_t N>
inline Dual<T, N> exp(const Dual<T, N>& a) {
    const T e = std::exp(a.v);
    return detail::chain(a, e, e);
}
template <class T, std::size_t N>
inline Dual<T, N> log(const Dual<T, N>& a) { return detail::chain(a, std::log(a.v), T(1) / a.v); }
template <class T, std::size_t N>
inline Dual<T, N> sin(const Dual<T, N>& a) { return detail::chain(a, std::sin(a.v), std::cos(a.v)); }
template <class T, std::size_t N>
inline Dual<T, N> cos(const Dual<T, N>& a) { return detail::chain(a, std::cos(a.v), -std::sin(a.v)); }
template <class T, std::size_t N>
inline Dual<T, N> tanh(const Dual<T, N>& a) {
    const T t = std::tanh(a.v);
    return detail::chain(a, t, T(1) - t * t);
}
template <class T, std::size_t N>
inline Dual<T, N> atan(const Dual<T, N>& a) { return detail::chain(a, std::atan(a.v), T(1) / (T(1) + a.v * a.v)); }
/// |a| with derivative sign(a) (0 at 0).
template <class T, std::size_t N>
inline Dual<T, N> fabs(const Dual<T, N>& a) {
    return detail::chain(a, std::fabs(a.v), a.v > T(0) ? T(1) : (a.v < T(0) ? T(-1) : T(0)));
}
template <class T, std::size_t N>
inline Dual<T, N> abs(const Dual<T, N>& a) { return fabs(a); }
/// a^p for a constant exponent.
template <class T, std::size_t N, class U, std::enable_if_t<std::is_arithmetic_v<U>, int> = 0>
inline Dual<T, N> pow(const Dual<T, N>& a, U p) {
    const T pe = static_cast<T>(p);
    const T fv = std::pow(a.v, pe);
    return detail::chain(a, fv, pe == T(0) ? T(0) : pe * std::pow(a.v, pe - T(1)));
}
/// a^b = exp(b·log a) for a > 0.
template <class T, std::size_t N>
inline Dual<T, N> pow(const Dual<T, N>& a, const Dual<T, N>& b) { return exp(b * log(a)); }

template <class T, std::size_t N>
inline bool isfinite(const Dual<T, N>& a) {
    if (!std::isfinite(a.v)) return false;
    for (T x : a.d) {
        if (!std::isfinite(x)) return false;
    }
    return true;
}

/// min / max pick a branch by value (derivative of the winner).
template <class T, std::size_t N>
constexpr Dual<T, N> fmin(const Dual<T, N>& a, const Dual<T, N>& b) { return b.v < a.v ? b : a; }
template <class T, std::size_t N>
constexpr Dual<T, N> fmax(const Dual<T, N>& a, const Dual<T, N>& b) { return a.v < b.v ? b : a; }

/// The scalar type a templated plant computes in for an input pair: a Dual
/// wins over a plain float, so `promote_t<float, Dual<double,3>>` is the Dual.
template <class A, class B>
using promote_t = std::conditional_t<is_dual_v<A>, A, std::conditional_t<is_dual_v<B>, B, std::common_type_t<A, B>>>;

} // namespace sim_core

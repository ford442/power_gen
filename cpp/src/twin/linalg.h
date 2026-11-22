#pragma once
// =============================================================
// twin/linalg.h  –  the dense linear algebra the twin needs, and no more.
//
// Every matrix here is tiny (the rig has 2 states, 3 sensors, 5 parameters;
// the caps are 8), row-major in a fixed std::array, double precision. No
// allocation, no exceptions, no external library (#257 constraint).
//
//   cholesky       A = L·Lᵀ for a symmetric positive-definite A (false if not)
//   chol_solve     A⁻¹·b from that factor
//   chol_inverse   A⁻¹ (symmetric) from that factor
//   jacobi_eigen   eigenvalues of a symmetric A (cyclic Jacobi rotations)
//   chi2_quantile  Wilson–Hilferty approximation of the χ²(k) quantile
// =============================================================

#include <array>
#include <cmath>
#include <cstddef>

namespace twin {

/// Lower-triangular Cholesky factor of the n×n leading block of a (stride S).
/// Writes L into l (upper part zeroed). False when a pivot is not positive.
template <std::size_t S>
inline bool cholesky(const std::array<double, S * S>& a, std::size_t n, std::array<double, S * S>& l) {
    l.fill(0.0);
    for (std::size_t j = 0; j < n; ++j) {
        double d = a[j * S + j];
        for (std::size_t k = 0; k < j; ++k) d -= l[j * S + k] * l[j * S + k];
        if (!(d > 0.0) || !std::isfinite(d)) return false;
        const double ljj = std::sqrt(d);
        l[j * S + j] = ljj;
        for (std::size_t i = j + 1; i < n; ++i) {
            double s = a[i * S + j];
            for (std::size_t k = 0; k < j; ++k) s -= l[i * S + k] * l[j * S + k];
            l[i * S + j] = s / ljj;
        }
    }
    return true;
}

/// Solve (L·Lᵀ)·x = b in place (first n entries of b).
template <std::size_t S>
inline void chol_solve(const std::array<double, S * S>& l, std::size_t n, std::array<double, S>& b) {
    for (std::size_t i = 0; i < n; ++i) {
        double s = b[i];
        for (std::size_t k = 0; k < i; ++k) s -= l[i * S + k] * b[k];
        b[i] = s / l[i * S + i];
    }
    for (std::size_t i = n; i-- > 0;) {
        double s = b[i];
        for (std::size_t k = i + 1; k < n; ++k) s -= l[k * S + i] * b[k];
        b[i] = s / l[i * S + i];
    }
}

/// inv = (L·Lᵀ)⁻¹, n×n block.
template <std::size_t S>
inline void chol_inverse(const std::array<double, S * S>& l, std::size_t n, std::array<double, S * S>& inv) {
    inv.fill(0.0);
    for (std::size_t c = 0; c < n; ++c) {
        std::array<double, S> e{};
        e[c] = 1.0;
        chol_solve<S>(l, n, e);
        for (std::size_t r = 0; r < n; ++r) inv[r * S + c] = e[r];
    }
    // Symmetrise the round-off.
    for (std::size_t r = 0; r < n; ++r) {
        for (std::size_t c = r + 1; c < n; ++c) {
            const double m = 0.5 * (inv[r * S + c] + inv[c * S + r]);
            inv[r * S + c] = m;
            inv[c * S + r] = m;
        }
    }
}

/// Eigenvalues of the symmetric n×n block of a (cyclic Jacobi; n ≤ S ≤ 16).
template <std::size_t S>
inline std::array<double, S> jacobi_eigen(std::array<double, S * S> a, std::size_t n) {
    for (int sweep = 0; sweep < 64; ++sweep) {
        double off = 0.0;
        for (std::size_t p = 0; p < n; ++p) {
            for (std::size_t q = p + 1; q < n; ++q) off += a[p * S + q] * a[p * S + q];
        }
        if (off < 1e-30) break;
        for (std::size_t p = 0; p < n; ++p) {
            for (std::size_t q = p + 1; q < n; ++q) {
                const double apq = a[p * S + q];
                if (std::fabs(apq) < 1e-300) continue;
                const double theta = (a[q * S + q] - a[p * S + p]) / (2.0 * apq);
                const double t = (theta >= 0 ? 1.0 : -1.0) / (std::fabs(theta) + std::sqrt(theta * theta + 1.0));
                const double c = 1.0 / std::sqrt(t * t + 1.0), s = t * c;
                for (std::size_t k = 0; k < n; ++k) {
                    const double akp = a[k * S + p], akq = a[k * S + q];
                    a[k * S + p] = c * akp - s * akq;
                    a[k * S + q] = s * akp + c * akq;
                }
                for (std::size_t k = 0; k < n; ++k) {
                    const double apk = a[p * S + k], aqk = a[q * S + k];
                    a[p * S + k] = c * apk - s * aqk;
                    a[q * S + k] = s * apk + c * aqk;
                }
            }
        }
    }
    std::array<double, S> ev{};
    for (std::size_t i = 0; i < n; ++i) ev[i] = a[i * S + i];
    return ev;
}

/// χ²(k) quantile at standard-normal z (Wilson–Hilferty; good to ~1 % for
/// k ≥ 3, which every consistency window here is). z = ±1.959964 → 2.5 / 97.5 %.
inline double chi2_quantile(double k, double z) {
    if (!(k > 0.0)) return 0.0;
    const double a = 2.0 / (9.0 * k);
    const double c = 1.0 - a + z * std::sqrt(a);
    return k * c * c * c;
}

inline constexpr double kZ975 = 1.959963984540054;

} // namespace twin

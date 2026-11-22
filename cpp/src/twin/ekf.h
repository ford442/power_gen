#pragma once
// =============================================================
// twin/ekf.h  –  extended Kalman filter over a sim_core::ParametricPlant
// (#257 §2, ADR-0019).
//
//   predict(dt, u)   x⁻ = Φ(x, θ, u, dt)       the bench integrator (RK4
//                                               substeps ≤ hMax), run on Duals,
//                    F  = ∂Φ/∂x                 so F is the exact Jacobian of
//                    P⁻ = F·P·Fᵀ + diag(q)·dt   the discrete map, not I + A·dt
//   update(z, mask)  ν = z − h(x⁻)              h, H = ∂h/∂x from outputs_p
//                    S = H·P⁻·Hᵀ + R            on Duals
//                    K = P⁻·Hᵀ·S⁻¹
//                    x = x⁻ + K·ν
//                    P = (I − K·H)·P⁻·(I − K·H)ᵀ + K·R·Kᵀ   (Joseph form)
//
// A channel missing from z (NaN, or its mask bit clear) is simply not in
// that update: a v2 board without current / voltage sensing is filtered on
// RPM alone.
//
// Consistency (the twin panel's residual gauge): NIS = νᵀ·S⁻¹·ν is χ²(m)
// when the model and the noise figures are right. Over the last W updates
// ΣNIS is χ²(Σm), so the window is "consistent" inside its 95 % band. Per
// channel the window also keeps the normalised innovation ν_c / √S_cc:
//
//   mean ≈ 0, rms ≈ 1               consistent
//   mean ≈ 0, rms > 1, lag-1 ≈ 0    the sensor is noisier than its σ
//   |mean| ≫ 0 or lag-1 ≫ 0         the model is wrong (calibrate)
//
// which is how "model wrong" and "sensor noisy" come apart.
//
// Everything is double. The filter never touches a coil: it reads samples
// and the drive the host already sent (docs/hardware_connection.md layering
// rule).
// =============================================================

#include "linalg.h"
#include "rig_plant.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>

namespace twin {

inline constexpr std::size_t kMaxDim = 8;
inline constexpr std::size_t kNisWindow = 100;

enum class Diagnosis : int { Idle = 0, Consistent = 1, SensorNoisy = 2, ModelMismatch = 3, Overcautious = 4 };

template <sim_core::ParametricPlant P>
class Ekf {
public:
    static constexpr std::size_t N = P::state_size;
    static constexpr std::size_t NP = P::param_size;
    static constexpr std::size_t M = P::output_size;
    static_assert(N <= kMaxDim && M <= kMaxDim && NP <= kMaxDim);

    using StateVec = std::array<double, N>;
    using Cov = std::array<double, N * N>;
    using Sensors = std::array<double, M>;

    P plant{};
    StateVec x{};
    Cov Pc{};
    std::array<double, NP> theta{};
    StateVec q{};       ///< process-noise density per state, unit²/s
    Sensors sigma{};    ///< sensor σ, in each sensor's unit
    double t{0.0};      ///< filter time, s
    double hMax{0.002};

    // Last update (NaN where a channel was absent).
    Sensors yPred{}, nu{}, nuSigma{}, ySigma{};
    double nis{0.0};
    int dof{0};
    std::uint32_t updates{0};

    Ekf() { reset_noise(); }

    /// Catalog noise figures (Rig::PROCESS_NOISE / SENSOR_SIGMA).
    void reset_noise() {
        for (std::size_t i = 0; i < N; ++i) q[i] = Rig::PROCESS_NOISE[i];
        for (std::size_t c = 0; c < M; ++c) sigma[c] = Rig::SENSOR_SIGMA[c];
    }

    void reset(const StateVec& x0, const StateVec& sd0) {
        x = x0;
        Pc.fill(0.0);
        for (std::size_t i = 0; i < N; ++i) Pc[i * N + i] = sd0[i] * sd0[i];
        t = 0.0;
        clear_window();
        const double nan = std::numeric_limits<double>::quiet_NaN();
        yPred.fill(nan);
        nu.fill(nan);
        nuSigma.fill(nan);
        ySigma.fill(nan);
        nis = 0.0;
        dof = 0;
        updates = 0;
    }

    void clear_window() {
        winNis.fill(0.0);
        winDof.fill(0);
        for (auto& ch : winNu) ch.fill(std::numeric_limits<double>::quiet_NaN());
        winHead = 0;
        winCount = 0;
    }

    /// Time update over dt with the drive held. False (state untouched) on a
    /// non-finite result.
    bool predict(double dt, const typename P::input_type& u) {
        if (!(dt > 0.0) || !std::isfinite(dt)) return false;
        using D = sim_core::Dual<double, N>;
        std::array<D, N> xd{};
        std::array<D, NP> thd{};
        for (std::size_t i = 0; i < N; ++i) xd[i] = D::variable(x[i], i);
        for (std::size_t j = 0; j < NP; ++j) thd[j] = D(theta[j]);
        advance(plant, t, xd, std::span<const D>(thd), u, dt, hMax);
        Cov F{};
        StateVec xn{};
        for (std::size_t i = 0; i < N; ++i) {
            if (!sim_core::isfinite(xd[i])) return false;
            xn[i] = xd[i].v;
            for (std::size_t j = 0; j < N; ++j) F[i * N + j] = xd[i].d[j];
        }
        // P⁻ = F·P·Fᵀ + Q·dt
        Cov FP{}, Pn{};
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = 0; j < N; ++j) {
                double s = 0.0;
                for (std::size_t k = 0; k < N; ++k) s += F[i * N + k] * Pc[k * N + j];
                FP[i * N + j] = s;
            }
        }
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = 0; j < N; ++j) {
                double s = 0.0;
                for (std::size_t k = 0; k < N; ++k) s += FP[i * N + k] * F[j * N + k];
                Pn[i * N + j] = s;
            }
            Pn[i * N + i] += q[i] * dt;
        }
        symmetrise(Pn);
        x = xn;
        Pc = Pn;
        t += dt;
        return true;
    }

    /// Measurement update. z[c] NaN or mask bit c clear → channel absent.
    /// Returns NIS, or −1 when no channel was present (or S was singular).
    double update(const Sensors& z, std::uint32_t mask, const typename P::input_type& u) {
        using D = sim_core::Dual<double, N>;
        std::array<D, N> xd{};
        std::array<D, NP> thd{};
        std::array<D, M> yd{};
        for (std::size_t i = 0; i < N; ++i) xd[i] = D::variable(x[i], i);
        for (std::size_t j = 0; j < NP; ++j) thd[j] = D(theta[j]);
        plant.template outputs_p<D>(std::span<const D>(xd), std::span<const D>(thd), u, std::span<D>(yd));

        std::array<std::size_t, M> idx{};
        std::size_t m = 0;
        const double nan = std::numeric_limits<double>::quiet_NaN();
        for (std::size_t c = 0; c < M; ++c) {
            yPred[c] = yd[c].v;
            nu[c] = nan;
            nuSigma[c] = nan;
            // Output σ from the prior (the band the analysis panel draws).
            double hph = 0.0;
            for (std::size_t a = 0; a < N; ++a) {
                for (std::size_t b = 0; b < N; ++b) hph += yd[c].d[a] * Pc[a * N + b] * yd[c].d[b];
            }
            ySigma[c] = std::sqrt(std::max(0.0, hph));
            if ((mask >> c) & 1u && std::isfinite(z[c]) && sigma[c] > 0.0) idx[m++] = c;
        }
        if (m == 0) return -1.0;

        // H (m×N), S = H·P·Hᵀ + R (m×m), PHᵀ (N×m)
        std::array<double, kMaxDim * kMaxDim> S{}, L{}, Sinv{};
        std::array<double, N * kMaxDim> PHt{};
        std::array<double, kMaxDim> v{};
        for (std::size_t r = 0; r < m; ++r) {
            const auto& yr = yd[idx[r]];
            v[r] = z[idx[r]] - yr.v;
            for (std::size_t a = 0; a < N; ++a) {
                double s = 0.0;
                for (std::size_t b = 0; b < N; ++b) s += Pc[a * N + b] * yr.d[b];
                PHt[a * kMaxDim + r] = s;
            }
        }
        for (std::size_t r = 0; r < m; ++r) {
            for (std::size_t c = 0; c < m; ++c) {
                double s = 0.0;
                for (std::size_t a = 0; a < N; ++a) s += yd[idx[r]].d[a] * PHt[a * kMaxDim + c];
                S[r * kMaxDim + c] = s;
            }
            const double sd = sigma[idx[r]];
            S[r * kMaxDim + r] += sd * sd;
        }
        if (!cholesky<kMaxDim>(S, m, L)) return -1.0;
        chol_inverse<kMaxDim>(L, m, Sinv);

        // K = PHᵀ·S⁻¹ (N×m)
        std::array<double, N * kMaxDim> K{};
        for (std::size_t a = 0; a < N; ++a) {
            for (std::size_t c = 0; c < m; ++c) {
                double s = 0.0;
                for (std::size_t r = 0; r < m; ++r) s += PHt[a * kMaxDim + r] * Sinv[r * kMaxDim + c];
                K[a * kMaxDim + c] = s;
            }
        }
        double nisNow = 0.0;
        for (std::size_t r = 0; r < m; ++r) {
            for (std::size_t c = 0; c < m; ++c) nisNow += v[r] * Sinv[r * kMaxDim + c] * v[c];
        }
        // Joseph form: P = (I − KH)·P·(I − KH)ᵀ + K·R·Kᵀ
        Cov IKH{}, T{}, Pn{};
        for (std::size_t a = 0; a < N; ++a) {
            for (std::size_t b = 0; b < N; ++b) {
                double s = a == b ? 1.0 : 0.0;
                for (std::size_t r = 0; r < m; ++r) s -= K[a * kMaxDim + r] * yd[idx[r]].d[b];
                IKH[a * N + b] = s;
            }
        }
        for (std::size_t a = 0; a < N; ++a) {
            for (std::size_t b = 0; b < N; ++b) {
                double s = 0.0;
                for (std::size_t k = 0; k < N; ++k) s += IKH[a * N + k] * Pc[k * N + b];
                T[a * N + b] = s;
            }
        }
        for (std::size_t a = 0; a < N; ++a) {
            for (std::size_t b = 0; b < N; ++b) {
                double s = 0.0;
                for (std::size_t k = 0; k < N; ++k) s += T[a * N + k] * IKH[b * N + k];
                for (std::size_t r = 0; r < m; ++r) {
                    const double sd = sigma[idx[r]];
                    s += K[a * kMaxDim + r] * sd * sd * K[b * kMaxDim + r];
                }
                Pn[a * N + b] = s;
            }
        }
        symmetrise(Pn);
        StateVec xn = x;
        for (std::size_t a = 0; a < N; ++a) {
            for (std::size_t r = 0; r < m; ++r) xn[a] += K[a * kMaxDim + r] * v[r];
        }
        for (double e : xn) {
            if (!std::isfinite(e)) return -1.0;
        }
        x = xn;
        Pc = Pn;

        for (std::size_t r = 0; r < m; ++r) {
            nu[idx[r]] = v[r];
            nuSigma[idx[r]] = std::sqrt(S[r * kMaxDim + r]);
        }
        nis = nisNow;
        dof = static_cast<int>(m);
        ++updates;
        push_window();
        return nisNow;
    }

    // ── consistency window ─────────────────────────────────────

    struct Window {
        double nisSum{0}, dofSum{0}, lo{0}, hi{0};
        std::size_t count{0};
        bool consistent{false};
        std::array<double, M> mean{}, rms{}, lag1{};
        std::array<std::size_t, M> n{};
        Diagnosis diagnosis{Diagnosis::Idle};
    };

    Window window() const {
        Window w;
        w.count = winCount;
        for (std::size_t k = 0; k < winCount; ++k) {
            w.nisSum += winNis[k];
            w.dofSum += winDof[k];
        }
        w.lo = chi2_quantile(w.dofSum, -kZ975);
        w.hi = chi2_quantile(w.dofSum, kZ975);
        w.consistent = winCount >= 10 && w.nisSum >= w.lo && w.nisSum <= w.hi;
        // Per channel, oldest → newest.
        bool anyBias = false, anyNoisy = false;
        for (std::size_t c = 0; c < M; ++c) {
            double s = 0, s2 = 0, sLag = 0, prev = std::numeric_limits<double>::quiet_NaN();
            std::size_t n = 0, nLag = 0;
            for (std::size_t k = 0; k < winCount; ++k) {
                const std::size_t slot = (winHead + kNisWindow - winCount + k) % kNisWindow;
                const double e = winNu[c][slot];
                if (!std::isfinite(e)) {
                    prev = std::numeric_limits<double>::quiet_NaN();
                    continue;
                }
                s += e;
                s2 += e * e;
                ++n;
                if (std::isfinite(prev)) {
                    sLag += e * prev;
                    ++nLag;
                }
                prev = e;
            }
            w.n[c] = n;
            const double nan = std::numeric_limits<double>::quiet_NaN();
            w.mean[c] = n ? s / static_cast<double>(n) : nan;
            w.rms[c] = n ? std::sqrt(s2 / static_cast<double>(n)) : nan;
            w.lag1[c] = (nLag && s2 > 0) ? (sLag / static_cast<double>(nLag)) / (s2 / static_cast<double>(n)) : nan;
            if (n >= 10) {
                // |mean| beyond 3 standard errors of a unit-variance mean, or
                // a lag-1 correlation beyond 3/√n: not white → the model.
                const double se = 1.0 / std::sqrt(static_cast<double>(n));
                if (std::fabs(w.mean[c]) > 3.0 * se || (std::isfinite(w.lag1[c]) && w.lag1[c] > 3.0 * se)) anyBias = true;
                else if (w.rms[c] > 1.0 + 3.0 * se) anyNoisy = true;
            }
        }
        if (winCount < 10) w.diagnosis = Diagnosis::Idle;
        else if (anyBias) w.diagnosis = Diagnosis::ModelMismatch;
        else if (anyNoisy || w.nisSum > w.hi) w.diagnosis = Diagnosis::SensorNoisy;
        else if (w.nisSum < w.lo) w.diagnosis = Diagnosis::Overcautious;
        else w.diagnosis = Diagnosis::Consistent;
        return w;
    }

    // ── snapshot (ADR-0015 extension) ──────────────────────────
    //   [version, N, NP, M, t, x(N), P(N²), θ(NP), q(N), σ(M), hMax]

    static constexpr int kSnapshotVersion = 1;
    static constexpr std::size_t kSnapshotSize = 5 + N + N * N + NP + N + M + 1;

    void save(std::span<double> out) const {
        std::size_t k = 0;
        out[k++] = kSnapshotVersion;
        out[k++] = static_cast<double>(N);
        out[k++] = static_cast<double>(NP);
        out[k++] = static_cast<double>(M);
        out[k++] = t;
        for (double e : x) out[k++] = e;
        for (double e : Pc) out[k++] = e;
        for (double e : theta) out[k++] = e;
        for (double e : q) out[k++] = e;
        for (double e : sigma) out[k++] = e;
        out[k++] = hMax;
    }

    /// Restore a save(). Refuses another layout or a non-finite value. The
    /// consistency window restarts (diagnostics only — the estimate does not).
    bool load(std::span<const double> in) {
        if (in.size() < kSnapshotSize) return false;
        if (in[0] != kSnapshotVersion || in[1] != N || in[2] != NP || in[3] != M) return false;
        for (std::size_t k = 4; k < kSnapshotSize; ++k) {
            if (!std::isfinite(in[k])) return false;
        }
        std::size_t k = 4;
        t = in[k++];
        for (double& e : x) e = in[k++];
        for (double& e : Pc) e = in[k++];
        for (double& e : theta) e = in[k++];
        for (double& e : q) e = in[k++];
        for (double& e : sigma) e = in[k++];
        const double h = in[k++];
        if (h > 0.0) hMax = h;
        clear_window();
        return true;
    }

private:
    std::array<double, kNisWindow> winNis{};
    std::array<int, kNisWindow> winDof{};
    std::array<std::array<double, kNisWindow>, M> winNu{};
    std::size_t winHead{0}, winCount{0};

    void push_window() {
        winNis[winHead] = nis;
        winDof[winHead] = dof;
        for (std::size_t c = 0; c < M; ++c) {
            winNu[c][winHead] = std::isfinite(nu[c]) && nuSigma[c] > 0 ? nu[c] / nuSigma[c]
                                                                         : std::numeric_limits<double>::quiet_NaN();
        }
        winHead = (winHead + 1) % kNisWindow;
        winCount = std::min(winCount + 1, kNisWindow);
    }

    static void symmetrise(Cov& a) {
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = i + 1; j < N; ++j) {
                const double m = 0.5 * (a[i * N + j] + a[j * N + i]);
                a[i * N + j] = m;
                a[j * N + i] = m;
            }
        }
    }
};

} // namespace twin

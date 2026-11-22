#pragma once
// =============================================================
// twin/sysid.h  –  system identification: Levenberg–Marquardt over a
// recorded run (#257 §3, ADR-0019).
//
// Output-error fit. Simulate the rig open-loop from x0 through the recorded
// drive (the twin's bench integrator, RK4 substeps ≤ hMax) and minimise
//
//   χ²(φ) = Σ_k Σ_c ((z_kc − y_c(x(t_k); θ)) / σ_c)²      (present channels)
//
// over the selected parameters, as φ = log θ (so θ > 0 and the catalog's
// [min, max] become a box), and optionally the initial state x0 (the run
// starts wherever the rig was — usually not at rest).
//
// Gradients are forward sensitivities: the whole simulation runs on
// Dual<double, NP + N> with θ seeded as exp(φ)·e_i and x0 as e_j, so every
// sample's ∂y/∂φ comes out of the integrator with the value — AD through
// RK4, not finite differences. JᵀJ and Jᵀr are accumulated sample by sample
// (no residual matrix is stored).
//
// After the fit:
//   cov(φ)      the sandwich (JᵀJ)⁻¹·B·(JᵀJ)⁻¹, B the Newey–West long-run
//               variance of the per-sample scores, each variance floored at
//               the classic s²·(JᵀJ)⁻¹. An open-loop simulation cannot follow
//               process noise, so its residuals are correlated and the classic
//               figure alone would overstate what the run pins down (Monte
//               Carlo over 24 seeds: z-RMS 0.9–1.3 per parameter, see
//               ADR-0019).                     (θ: delta method, σ_θ = θ·σ_φ)
//   R²_c        1 − SS_res/SS_tot per sensor channel
//   condition   λmax/λmin of the correlation-scaled JᵀJ
//   warnings    a parameter whose relative σ exceeds 25 % or that ends on a
//               bound is flagged "not identified from this run"; a condition
//               above 1e10 flags the whole fit as near-singular
//
// The data never leave this object as anything but a fit: no I/O, no
// allocation after load(), no exceptions.
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
#include <utility>
#include <vector>

namespace twin {

enum class FitStatus : int {
    Idle = 0,
    Running = 1,
    Converged = 2,
    MaxIterations = 3,
    Failed = -1,
};

/// warnings() bits: (1 << i) parameter i not identified; plus these.
inline constexpr std::uint32_t kWarnSingular = 1u << 16;
inline constexpr std::uint32_t kWarnNotConverged = 1u << 17;
inline constexpr std::uint32_t kWarnPoorFit = 1u << 18;
inline constexpr double kIdentifiableRelSigma = 0.25;

template <sim_core::ParametricPlant P>
class SysId {
public:
    static constexpr std::size_t N = P::state_size;
    static constexpr std::size_t NP = P::param_size;
    static constexpr std::size_t M = P::output_size;
    static constexpr std::size_t K = NP + N; ///< max free directions
    static constexpr std::size_t STRIDE = 2 + M; ///< per sample: t, v, z[M]

    P plant{};
    /// Packed samples [t s, v V, z_0 … z_{M−1}] (NaN = channel absent).
    std::vector<double> data;
    std::size_t count{0};

    std::array<double, NP> theta{};   ///< current θ (start → fit)
    std::array<double, NP> lo{}, hi{};
    std::array<bool, NP> fit{};
    std::array<double, N> x0{};
    bool fitX0{true};
    std::array<double, M> sigma{};
    double hMax{0.002};
    int maxIter{60};

    SysId() {
        for (std::size_t i = 0; i < NP; ++i) {
            theta[i] = Rig::PARAM_NOMINAL[i];
            lo[i] = Rig::PARAM_MIN[i];
            hi[i] = Rig::PARAM_MAX[i];
            fit[i] = true;
        }
        for (std::size_t c = 0; c < M; ++c) sigma[c] = Rig::SENSOR_SIGMA[c];
        hMax = Rig::H_MAX;
    }

    double* dataPtr(std::size_t samples) {
        data.assign(samples * STRIDE, 0.0);
        count = 0;
        return data.data();
    }

    /// Validate the packed run. 0 = ok; otherwise an error code (errorText()).
    int load(std::size_t samples) {
        status_ = FitStatus::Idle;
        if (samples * STRIDE > data.size()) return fail(1, "more samples than the buffer holds");
        if (samples < 20) return fail(2, "fewer than 20 samples");
        std::size_t present = 0;
        for (std::size_t k = 0; k < samples; ++k) {
            const double* s = &data[k * STRIDE];
            if (!std::isfinite(s[0]) || !std::isfinite(s[1])) return fail(3, "a sample time or drive is not finite");
            if (k > 0) {
                const double dt = s[0] - data[(k - 1) * STRIDE];
                if (!(dt > 0.0)) return fail(4, "sample times must increase");
                if (dt > 1.0) return fail(5, "a gap over 1 s in the run (split it)");
            }
            for (std::size_t c = 0; c < M; ++c) present += std::isfinite(s[2 + c]) ? 1 : 0;
        }
        if (present < 20) return fail(6, "fewer than 20 measured values");
        count = samples;
        error_ = "";
        return 0;
    }

    /// Begin a fit from theta / x0 (clamped into the bounds).
    FitStatus start() {
        if (count == 0) {
            fail(7, "no run loaded");
            return status_ = FitStatus::Failed;
        }
        nFree_ = 0;
        for (std::size_t i = 0; i < NP; ++i) {
            if (!fit[i]) continue;
            const double th = std::clamp(theta[i], lo[i], hi[i]);
            dir_[nFree_] = static_cast<int>(i);
            phi_[nFree_] = std::log(th);
            ++nFree_;
        }
        if (fitX0) {
            for (std::size_t j = 0; j < N; ++j) {
                dir_[nFree_] = static_cast<int>(NP + j);
                phi_[nFree_] = x0[j];
                ++nFree_;
            }
        }
        if (nFree_ == 0) {
            fail(8, "nothing to fit");
            return status_ = FitStatus::Failed;
        }
        lambda_ = 1e-3;
        iter_ = 0;
        costHistory_.clear();
        if (!evaluate_jac(phi_)) {
            fail(9, "the start point does not simulate (non-finite)");
            return status_ = FitStatus::Failed;
        }
        costHistory_.push_back(cost_);
        status_ = FitStatus::Running;
        return status_;
    }

    /// One accepted LM step (or the verdict that none is possible).
    FitStatus iterate() {
        if (status_ != FitStatus::Running) return status_;
        for (int tries = 0; tries < 16; ++tries) {
            std::array<double, K * K> Ad{}, L{};
            double dmax = 0.0;
            for (std::size_t i = 0; i < nFree_; ++i) dmax = std::max(dmax, A_[i * K + i]);
            for (std::size_t i = 0; i < nFree_; ++i) {
                for (std::size_t j = 0; j < nFree_; ++j) Ad[i * K + j] = A_[i * K + j];
                Ad[i * K + i] += lambda_ * A_[i * K + i] + 1e-14 * dmax + 1e-300;
            }
            if (!cholesky<K>(Ad, nFree_, L)) {
                lambda_ = std::min(lambda_ * 10.0, 1e12);
                continue;
            }
            std::array<double, K> delta{};
            for (std::size_t i = 0; i < nFree_; ++i) delta[i] = -g_[i];
            chol_solve<K>(L, nFree_, delta);
            std::array<double, K> trial = phi_;
            double stepMax = 0.0;
            for (std::size_t i = 0; i < nFree_; ++i) {
                // Keep one step inside a factor of e per log parameter.
                const bool isParam = dir_[i] < static_cast<int>(NP);
                const double d = isParam ? std::clamp(delta[i], -1.0, 1.0) : delta[i];
                trial[i] = phi_[i] + d;
                if (isParam) {
                    const std::size_t p = static_cast<std::size_t>(dir_[i]);
                    trial[i] = std::clamp(trial[i], std::log(lo[p]), std::log(hi[p]));
                }
                stepMax = std::max(stepMax, std::fabs(trial[i] - phi_[i]));
            }
            const double costTry = evaluate_value(trial);
            if (std::isfinite(costTry) && costTry < cost_) {
                const double rel = (cost_ - costTry) / std::max(cost_, 1e-300);
                phi_ = trial;
                lambda_ = std::max(lambda_ * 0.3, 1e-12);
                if (!evaluate_jac(phi_)) {
                    fail(10, "the fit left the region where the rig simulates");
                    return status_ = FitStatus::Failed;
                }
                ++iter_;
                costHistory_.push_back(cost_);
                if (rel < 1e-10 || stepMax < 1e-10) return finish(FitStatus::Converged);
                if (iter_ >= maxIter) return finish(FitStatus::MaxIterations);
                return status_;
            }
            lambda_ = std::min(lambda_ * 4.0, 1e12);
        }
        // No step lowers χ² at any damping: a (local) minimum.
        return finish(FitStatus::Converged);
    }

    /// Run to the end (native tests; the worker loops iterate() for progress).
    FitStatus run() {
        if (start() != FitStatus::Running) return status_;
        while (iterate() == FitStatus::Running) {
        }
        return status_;
    }

    // ── results ───────────────────────────────────────────────
    FitStatus status() const { return status_; }
    int iterations() const { return iter_; }
    double cost() const { return cost_; }
    double lambda() const { return lambda_; }
    const std::vector<double>& costHistory() const { return costHistory_; }
    std::size_t residualCount() const { return nRes_; }
    double reducedChi2() const { return s2_; }
    double condition() const { return cond_; }
    /// Pooled lag-1 autocorrelation of the normalised residuals at the fit.
    double residualAutocorr() const { return rho_; }
    /// Largest variance ratio reported / classic s²·(JᵀJ)⁻¹ — how much the
    /// residual correlation widened the reported σ² (≥ 1).
    double covarianceInflation() const { return inflate_; }
    std::uint32_t warnings() const { return warn_; }
    const char* errorText() const { return error_; }

    /// θ_i at the current φ (the start value when it is held fixed).
    double param(std::size_t i) const { return i < NP ? thetaNow_[i] : std::numeric_limits<double>::quiet_NaN(); }
    double initialState(std::size_t j) const { return j < N ? x0Now_[j] : std::numeric_limits<double>::quiet_NaN(); }
    /// Covariance of θ (zero row/column for a held parameter).
    double covariance(std::size_t i, std::size_t j) const {
        return (i < NP && j < NP) ? covTheta_[i * NP + j] : std::numeric_limits<double>::quiet_NaN();
    }
    double r2(std::size_t c) const { return c < M ? r2_[c] : std::numeric_limits<double>::quiet_NaN(); }
    double rmsNormalized(std::size_t c) const { return c < M ? rms_[c] : std::numeric_limits<double>::quiet_NaN(); }

    /// Simulated outputs at the current fit, count × M (for the fit plot).
    void simulate(std::span<double> out) const {
        Values v;
        run_sim<double>(build<double>(phi_), &v, nullptr, out);
    }

private:
    FitStatus status_{FitStatus::Idle};
    const char* error_{""};
    std::array<int, K> dir_{};     ///< free direction → param index, or NP + state index
    std::array<double, K> phi_{};
    std::size_t nFree_{0};
    double lambda_{1e-3};
    int iter_{0};
    double cost_{0.0};
    std::array<double, K * K> A_{};
    std::array<double, K> g_{};
    std::vector<double> costHistory_;
    std::size_t nRes_{0};
    double s2_{0.0}, cond_{0.0}, rho_{0.0}, inflate_{1.0};
    std::uint32_t warn_{0};
    std::array<double, NP> thetaNow_{};
    std::array<double, N> x0Now_{};
    std::array<double, NP * NP> covTheta_{};
    std::array<double, M> r2_{}, rms_{};

    int fail(int code, const char* why) {
        error_ = why;
        status_ = FitStatus::Failed;
        return code;
    }

    template <class S>
    struct Point {
        std::array<S, NP> th{};
        std::array<S, N> x{};
    };

    /// θ and x0 as S at φ (free directions seeded when S is a Dual).
    template <class S>
    Point<S> build(const std::array<double, K>& phi) const {
        Point<S> pt;
        for (std::size_t i = 0; i < NP; ++i) pt.th[i] = S(std::clamp(theta[i], lo[i], hi[i]));
        for (std::size_t j = 0; j < N; ++j) pt.x[j] = S(x0[j]);
        for (std::size_t f = 0; f < nFree_; ++f) {
            const int d = dir_[f];
            if (d < static_cast<int>(NP)) {
                const double th = std::exp(phi[f]);
                if constexpr (sim_core::is_dual_v<S>) {
                    S seeded(th);
                    seeded.d[f] = th; // ∂θ/∂φ = θ (φ = log θ)
                    pt.th[static_cast<std::size_t>(d)] = seeded;
                } else {
                    pt.th[static_cast<std::size_t>(d)] = th;
                }
            } else {
                const std::size_t j = static_cast<std::size_t>(d) - NP;
                if constexpr (sim_core::is_dual_v<S>) pt.x[j] = S::variable(phi[f], f);
                else pt.x[j] = phi[f];
            }
        }
        return pt;
    }

    struct Values {
        double chi2{0};
        std::size_t n{0};
        std::array<double, M> ssRes{}, sum{}, sum2{};
        std::array<std::size_t, M> nc{};
        // Lag-1 products of consecutive normalised residuals, per channel.
        std::array<double, M> lagSum{}, lastR{};
        std::array<std::size_t, M> lagN{};
        std::array<bool, M> hasLast{};
        bool finite{true};
    };

    /// Simulate the run at pt; accumulate χ², and JᵀJ / Jᵀr when S is a Dual.
    template <class S>
    void run_sim(Point<S> pt, Values* v, std::pair<std::array<double, K * K>*, std::array<double, K>*>* jac,
                 std::span<double> trace = {}, std::vector<std::array<double, K>>* scores = nullptr) const {
        std::array<S, N> x = pt.x;
        std::array<S, M> y{};
        for (std::size_t k = 0; k < count; ++k) {
            const double* s = &data[k * STRIDE];
            if (k > 0) {
                const double t0 = data[(k - 1) * STRIDE];
                advance(plant, t0, x, std::span<const S>(pt.th), RigInput{s[1]}, s[0] - t0, hMax);
            }
            plant.template outputs_p<S>(std::span<const S>(x), std::span<const S>(pt.th), RigInput{s[1]}, std::span<S>(y));
            for (std::size_t c = 0; c < M; ++c) {
                const double yv = sim_core::value_of(y[c]);
                if (!trace.empty()) trace[k * M + c] = yv;
                const double z = s[2 + c];
                if (!std::isfinite(z)) {
                    v->hasLast[c] = false;
                    continue;
                }
                if (!std::isfinite(yv)) {
                    v->finite = false;
                    return;
                }
                const double r = (z - yv) / sigma[c];
                if (v->hasLast[c]) {
                    v->lagSum[c] += r * v->lastR[c];
                    v->lagN[c] += 1;
                }
                v->lastR[c] = r;
                v->hasLast[c] = true;
                v->chi2 += r * r;
                v->n += 1;
                v->ssRes[c] += (z - yv) * (z - yv);
                v->sum[c] += z;
                v->sum2[c] += z * z;
                v->nc[c] += 1;
                if constexpr (sim_core::is_dual_v<S>) {
                    if (jac) {
                        auto& A = *jac->first;
                        auto& g = *jac->second;
                        std::array<double, K> jr{};
                        for (std::size_t f = 0; f < nFree_; ++f) jr[f] = -y[c].d[f] / sigma[c];
                        for (std::size_t a = 0; a < nFree_; ++a) {
                            g[a] += jr[a] * r;
                            for (std::size_t b = 0; b <= a; ++b) A[a * K + b] += jr[a] * jr[b];
                        }
                    }
                    if (scores) {
                        for (std::size_t f = 0; f < nFree_; ++f) (*scores)[k][f] += -y[c].d[f] / sigma[c] * r;
                    }
                }
            }
        }
    }

    double evaluate_value(const std::array<double, K>& phi) const {
        Values v;
        run_sim<double>(build<double>(phi), &v, nullptr);
        return v.finite ? v.chi2 : std::numeric_limits<double>::infinity();
    }

    bool evaluate_jac(const std::array<double, K>& phi) {
        using D = sim_core::Dual<double, K>;
        Values v;
        std::array<double, K * K> A{};
        std::array<double, K> g{};
        std::pair<std::array<double, K * K>*, std::array<double, K>*> jac{&A, &g};
        run_sim<D>(build<D>(phi), &v, &jac);
        if (!v.finite || !std::isfinite(v.chi2)) return false;
        for (std::size_t a = 0; a < nFree_; ++a) {
            for (std::size_t b = a + 1; b < nFree_; ++b) A[a * K + b] = A[b * K + a];
        }
        A_ = A;
        g_ = g;
        cost_ = v.chi2;
        nRes_ = v.n;
        // Snapshot the point + per-channel stats (finish() builds the rest).
        const Point<double> pt = build<double>(phi);
        thetaNow_ = pt.th;
        x0Now_ = pt.x;
        // Residual lag-1 autocorrelation, pooled over channels: white
        // residuals give ~0; process noise or unmodelled dynamics an
        // open-loop simulation cannot follow give > 0.
        double lag = 0.0, var = 0.0;
        for (std::size_t c = 0; c < M; ++c) {
            if (v.lagN[c] == 0 || v.nc[c] == 0) continue;
            lag += v.lagSum[c];
            var += v.ssRes[c] / (sigma[c] * sigma[c]) * static_cast<double>(v.lagN[c]) / static_cast<double>(v.nc[c]);
        }
        rho_ = var > 0 ? std::clamp(lag / var, -0.99, 0.99) : 0.0;
        for (std::size_t c = 0; c < M; ++c) {
            const double n = static_cast<double>(v.nc[c]);
            if (v.nc[c] < 2) {
                r2_[c] = rms_[c] = std::numeric_limits<double>::quiet_NaN();
                continue;
            }
            const double ssTot = v.sum2[c] - v.sum[c] * v.sum[c] / n;
            r2_[c] = ssTot > 0 ? 1.0 - v.ssRes[c] / ssTot : std::numeric_limits<double>::quiet_NaN();
            rms_[c] = std::sqrt(v.ssRes[c] / n) / sigma[c];
        }
        return true;
    }

    /// Newey–West (Bartlett) long-run variance of the per-sample scores
    /// g_k = Σ_c (∂r/∂φ)·r at the fit, scaled by 1/dsq like the normal
    /// matrix. White residuals give B ≈ JᵀJ (so the sandwich is the usual
    /// (JᵀJ)⁻¹); process noise an open-loop simulation cannot follow makes
    /// them correlated over a mechanical time constant, and B grows to say so.
    /// Bandwidth: 1.5 s of samples (a few mechanical time constants; longer
    /// windows bias it low, because the scores sum to zero at the fit).
    std::array<double, K * K> score_long_run_variance(const std::array<double, K>& dsq) const {
        using D = sim_core::Dual<double, K>;
        std::vector<std::array<double, K>> sc(count, std::array<double, K>{});
        Values v;
        run_sim<D>(build<D>(phi_), &v, nullptr, {}, &sc);
        for (auto& g : sc) {
            for (std::size_t f = 0; f < nFree_; ++f) g[f] /= dsq[f];
        }
        const double span = data[(count - 1) * STRIDE] - data[0];
        const double meanDt = count > 1 ? span / static_cast<double>(count - 1) : 1.0;
        const std::size_t lag = std::min<std::size_t>(count / 4, static_cast<std::size_t>(std::ceil(1.5 / std::max(meanDt, 1e-6))));
        std::array<double, K * K> B{};
        for (std::size_t l = 0; l <= lag; ++l) {
            const double w = l == 0 ? 1.0 : 1.0 - static_cast<double>(l) / static_cast<double>(lag + 1);
            for (std::size_t k = l; k < count; ++k) {
                const auto& g0 = sc[k];
                const auto& g1 = sc[k - l];
                for (std::size_t a = 0; a < nFree_; ++a) {
                    for (std::size_t b = 0; b < nFree_; ++b) {
                        const double gg = g0[a] * g1[b];
                        B[a * K + b] += l == 0 ? gg : w * (gg + g1[a] * g0[b]);
                    }
                }
            }
        }
        return B;
    }

    FitStatus finish(FitStatus s) {
        status_ = s;
        warn_ = s == FitStatus::MaxIterations ? kWarnNotConverged : 0u;
        const double dofRes = static_cast<double>(nRes_) - static_cast<double>(nFree_);
        s2_ = dofRes > 0 ? cost_ / dofRes : std::numeric_limits<double>::quiet_NaN();
        covTheta_.fill(0.0);
        // Correlation-scaled JᵀJ: its condition number is the identifiability test.
        std::array<double, K * K> C{}, L{}, inv{};
        std::array<double, K> dsq{};
        for (std::size_t i = 0; i < nFree_; ++i) dsq[i] = std::sqrt(std::max(A_[i * K + i], 1e-300));
        for (std::size_t i = 0; i < nFree_; ++i) {
            for (std::size_t j = 0; j < nFree_; ++j) C[i * K + j] = A_[i * K + j] / (dsq[i] * dsq[j]);
        }
        const auto ev = jacobi_eigen<K>(C, nFree_);
        double emax = 0.0, emin = std::numeric_limits<double>::infinity();
        for (std::size_t i = 0; i < nFree_; ++i) {
            emax = std::max(emax, ev[i]);
            emin = std::min(emin, ev[i]);
        }
        cond_ = emin > 0 ? emax / emin : std::numeric_limits<double>::infinity();
        const bool ok = cholesky<K>(C, nFree_, L);
        if (!ok || !(cond_ < 1e10)) {
            warn_ |= kWarnSingular;
            for (std::size_t f = 0; f < nFree_; ++f) {
                if (dir_[f] < static_cast<int>(NP)) warn_ |= 1u << dir_[f];
            }
        } else {
            chol_inverse<K>(L, nFree_, inv);
            // Sandwich covariance A⁻¹·B·A⁻¹ in the scaled coordinates, with B
            // the long-run variance of the per-sample scores (below).
            const auto B = score_long_run_variance(dsq);
            std::array<double, K * K> IB{}, covS{};
            for (std::size_t a = 0; a < nFree_; ++a) {
                for (std::size_t b = 0; b < nFree_; ++b) {
                    double acc = 0.0;
                    for (std::size_t k = 0; k < nFree_; ++k) acc += inv[a * K + k] * B[k * K + b];
                    IB[a * K + b] = acc;
                }
            }
            for (std::size_t a = 0; a < nFree_; ++a) {
                for (std::size_t b = 0; b < nFree_; ++b) {
                    double acc = 0.0;
                    for (std::size_t k = 0; k < nFree_; ++k) acc += IB[a * K + k] * inv[k * K + b];
                    covS[a * K + b] = acc;
                }
            }
            // Never report less than the classic s²·(JᵀJ)⁻¹ (white residuals:
            // the HAC estimate is the noisier of the two). Scale rows/columns
            // so each variance is at least that, keeping the sandwich's
            // correlations — and the matrix positive semi-definite.
            const double s2c = std::isfinite(s2_) ? s2_ : 1.0;
            std::array<double, K> f{};
            double ratio = 0.0;
            for (std::size_t a = 0; a < nFree_; ++a) {
                const double classic = s2c * inv[a * K + a];
                const double hac = covS[a * K + a];
                f[a] = hac > 0 ? std::sqrt(std::max(1.0, classic / hac)) : 1.0;
                ratio = std::max(ratio, hac * f[a] * f[a] / std::max(classic, 1e-300));
            }
            for (std::size_t a = 0; a < nFree_; ++a) {
                for (std::size_t b = 0; b < nFree_; ++b) covS[a * K + b] *= f[a] * f[b];
            }
            inflate_ = ratio;
            for (std::size_t a = 0; a < nFree_; ++a) {
                if (dir_[a] >= static_cast<int>(NP)) continue;
                const std::size_t pa = static_cast<std::size_t>(dir_[a]);
                for (std::size_t b = 0; b < nFree_; ++b) {
                    if (dir_[b] >= static_cast<int>(NP)) continue;
                    const std::size_t pb = static_cast<std::size_t>(dir_[b]);
                    const double covPhi = covS[a * K + b] / (dsq[a] * dsq[b]);
                    covTheta_[pa * NP + pb] = covPhi * thetaNow_[pa] * thetaNow_[pb];
                }
                const double relSigma = std::sqrt(std::max(0.0, covTheta_[pa * NP + pa])) / thetaNow_[pa];
                const double logLo = std::log(lo[pa]), logHi = std::log(hi[pa]);
                const bool atBound = phi_[a] <= logLo + 1e-9 || phi_[a] >= logHi - 1e-9;
                if (!(relSigma <= kIdentifiableRelSigma) || atBound) warn_ |= 1u << pa;
            }
        }
        for (std::size_t c = 0; c < M; ++c) {
            if (std::isfinite(r2_[c]) && r2_[c] < 0.9) warn_ |= kWarnPoorFit;
        }
        return status_;
    }
};

} // namespace twin

// =============================================================
// standalone_twin.cpp  –  --mode ad and --mode twin (#257)
//
// --mode ad      AD (core/dual.h) against central differences:
//                  * ∂f/∂x of every DifferentiablePlant (homopolar, jumping
//                    ring, the twin rig) — the Dual<float> Jacobian ros23 uses
//                    within 1e-3 relative, the Dual<double> one within 1e-6
//                  * the rig's ∂f/∂θ, and the RK4 map's sensitivities
//                    ∂x⁺/∂x and ∂x⁺/∂θ (what the EKF and sysid differentiate)
// --mode twin    a ground-truth rig (catalog θ × (1 ± 0.2), process + sensor
//                noise at the catalog figures, 125 Hz samples, a 30 s drive
//                staircase) through the exported TwinEstimator / TwinSysId:
//                  * the EKF on the true θ is χ²-consistent; on the nominal θ
//                    it is not, and says "model mismatch"
//                  * calibration from nominal recovers every θ within 5 %
//                  * RPM alone cannot identify all five (warnings set)
//                  * a mid-run filter snapshot restores bit-identically
//
// Prints `ad.check …` / `twin.check <what> value=… limit=… ok|FAIL` and
// `twin.param …`; exit 1 on any FAIL. scripts/tests/twin.test.mjs parses it.
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <span>
#include <vector>

namespace {

int g_fail = 0;

void check(const char* tag, const char* what, double value, double limit, bool ok) {
    std::printf("%s.check %s value=%.3e limit=%.3e %s\n", tag, what, value, limit, ok ? "ok" : "FAIL");
    if (!ok) ++g_fail;
}

// ── --mode ad ─────────────────────────────────────────────────

/// max_ij |A − C| / max(max_j |C_ij|, floor) over rows.
template <std::size_t R, std::size_t C>
double rel_err(const std::array<double, R * C>& a, const std::array<double, R * C>& c) {
    double worst = 0.0;
    for (std::size_t i = 0; i < R; ++i) {
        double scale = 0.0;
        for (std::size_t j = 0; j < C; ++j) scale = std::max(scale, std::fabs(c[i * C + j]));
        if (scale < 1e-300) continue;
        for (std::size_t j = 0; j < C; ++j) worst = std::max(worst, std::fabs(a[i * C + j] - c[i * C + j]) / scale);
    }
    return worst;
}

/// ∂f/∂x by central differences on the double instantiation.
template <class P>
std::array<double, P::state_size * P::state_size> cd_jacobian(const P& p, double t, const std::array<double, P::state_size>& x,
                                                              const typename P::input_type& u) {
    constexpr std::size_t N = P::state_size;
    std::array<double, N * N> J{};
    for (std::size_t j = 0; j < N; ++j) {
        const double h = 1e-6 * std::max(1.0, std::fabs(x[j]));
        std::array<double, N> xp = x, xm = x, fp{}, fm{};
        xp[j] += h;
        xm[j] -= h;
        p.template derivs_t<double>(t, std::span<const double>(xp), u, std::span<double>(fp));
        p.template derivs_t<double>(t, std::span<const double>(xm), u, std::span<double>(fm));
        for (std::size_t i = 0; i < N; ++i) J[i * N + j] = (fp[i] - fm[i]) / (2.0 * h);
    }
    return J;
}

template <class P>
void check_plant(const char* name, const P& p, double t, const std::array<double, P::state_size>& x,
                 const typename P::input_type& u) {
    constexpr std::size_t N = P::state_size;
    const auto cd = cd_jacobian(p, t, x, u);
    // Dual<float> — the Jacobian ros23 uses.
    std::array<float, N> xf{}, ff{};
    std::array<float, N * N> Jf{};
    for (std::size_t i = 0; i < N; ++i) xf[i] = static_cast<float>(x[i]);
    sim_core::jacobian_x(p, t, std::span<const float>(xf), u, std::span<float>(ff), std::span<float>(Jf));
    std::array<double, N * N> a32{};
    for (std::size_t i = 0; i < N * N; ++i) a32[i] = Jf[i];
    // Dual<double> — the AD itself, without float rounding.
    using D = sim_core::Dual<double, N>;
    std::array<D, N> xd{}, fd{};
    for (std::size_t j = 0; j < N; ++j) xd[j] = D::variable(x[j], j);
    p.template derivs_t<D>(t, std::span<const D>(xd), u, std::span<D>(fd));
    std::array<double, N * N> a64{};
    for (std::size_t i = 0; i < N; ++i) {
        for (std::size_t j = 0; j < N; ++j) a64[i * N + j] = fd[i].d[j];
    }
    char what[96];
    std::snprintf(what, sizeof what, "%s.dfdx.f32", name);
    const double e32 = rel_err<N, N>(a32, cd);
    check("ad", what, e32, 1e-3, e32 <= 1e-3);
    std::snprintf(what, sizeof what, "%s.dfdx.f64", name);
    const double e64 = rel_err<N, N>(a64, cd);
    check("ad", what, e64, 1e-6, e64 <= 1e-6);
}

void check_rig_sensitivities(const twin::RigPlant& rig, const std::array<double, 2>& x0, double v) {
    constexpr std::size_t N = twin::RigPlant::state_size, NP = twin::RigPlant::param_size;
    std::array<double, NP> th{};
    for (std::size_t j = 0; j < NP; ++j) th[j] = twin::Rig::PARAM_NOMINAL[j];
    const twin::RigInput u{v};
    // ∂f/∂θ
    {
        using D = sim_core::Dual<double, NP>;
        std::array<D, N> xd{}, fd{};
        std::array<D, NP> thd{};
        for (std::size_t i = 0; i < N; ++i) xd[i] = D(x0[i]);
        for (std::size_t j = 0; j < NP; ++j) thd[j] = D::variable(th[j], j);
        rig.derivs_p<D>(0.0, std::span<const D>(xd), std::span<const D>(thd), u, std::span<D>(fd));
        std::array<double, N * NP> ad{}, cd{};
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t j = 0; j < NP; ++j) ad[i * NP + j] = fd[i].d[j];
        }
        for (std::size_t j = 0; j < NP; ++j) {
            const double h = 1e-6 * th[j];
            std::array<double, NP> tp = th, tm = th;
            tp[j] += h;
            tm[j] -= h;
            std::array<double, N> fp{}, fm{};
            rig.derivs_p<double>(0.0, std::span<const double>(x0), std::span<const double>(tp), u, std::span<double>(fp));
            rig.derivs_p<double>(0.0, std::span<const double>(x0), std::span<const double>(tm), u, std::span<double>(fm));
            for (std::size_t i = 0; i < N; ++i) cd[i * NP + j] = (fp[i] - fm[i]) / (2.0 * h);
        }
        const double e = rel_err<N, NP>(ad, cd);
        check("ad", "rig.dfdtheta", e, 1e-6, e <= 1e-6);
    }
    // ∂x⁺/∂x and ∂x⁺/∂θ of the RK4 map over one 8 ms sample (4 substeps).
    {
        constexpr std::size_t K = N + NP;
        using D = sim_core::Dual<double, K>;
        std::array<D, N> xd{};
        std::array<D, NP> thd{};
        for (std::size_t i = 0; i < N; ++i) xd[i] = D::variable(x0[i], i);
        for (std::size_t j = 0; j < NP; ++j) thd[j] = D::variable(th[j], N + j);
        twin::advance(rig, 0.0, xd, std::span<const D>(thd), u, 0.008, twin::Rig::H_MAX);
        std::array<double, N * K> ad{}, cd{};
        for (std::size_t i = 0; i < N; ++i) {
            for (std::size_t k = 0; k < K; ++k) ad[i * K + k] = xd[i].d[k];
        }
        for (std::size_t k = 0; k < K; ++k) {
            std::array<double, N> xp = x0, xm = x0;
            std::array<double, NP> tp = th, tm = th;
            double h;
            if (k < N) {
                h = 1e-6 * std::max(1.0, std::fabs(x0[k]));
                xp[k] += h;
                xm[k] -= h;
            } else {
                h = 1e-6 * th[k - N];
                tp[k - N] += h;
                tm[k - N] -= h;
            }
            twin::advance(rig, 0.0, xp, std::span<const double>(tp), u, 0.008, twin::Rig::H_MAX);
            twin::advance(rig, 0.0, xm, std::span<const double>(tm), u, 0.008, twin::Rig::H_MAX);
            for (std::size_t i = 0; i < N; ++i) cd[i * K + k] = (xp[i] - xm[i]) / (2.0 * h);
        }
        const double e = rel_err<N, K>(ad, cd);
        check("ad", "rig.rk4.sensitivity", e, 1e-6, e <= 1e-6);
    }
}

// ── --mode twin ───────────────────────────────────────────────

/// xorshift64* + Box–Muller: a fixed, portable noise stream.
struct Rng {
    std::uint64_t s{0x9E3779B97F4A7C15ull};
    double uniform() {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        return static_cast<double>((s * 0x2545F4914F6CDD1Dull) >> 11) * (1.0 / 9007199254740992.0);
    }
    double normal() {
        const double u1 = std::max(uniform(), 1e-300), u2 = uniform();
        return std::sqrt(-2.0 * std::log(u1)) * std::cos(6.283185307179586 * u2);
    }
};

struct Run {
    std::vector<double> t, v;
    std::vector<std::array<double, 3>> z;
    std::array<double, 5> thetaTrue{};
};

double drive_volts(double rpm) {
    return std::clamp(twin::Rig::V_PER_RPM * rpm, -twin::Rig::V_MAX, twin::Rig::V_MAX);
}

/// 30 s, 125 Hz, staircase drive; truth integrated at 1 ms with process noise.
Run make_run(double paramError, double seconds) {
    static constexpr double kStairs[] = { 300, 700, 450, 900, 200, 600, 0, 800, 350, 650, 500, 0 };
    Run r;
    const double sign[5] = { 1, -1, 1, -1, 1 };
    for (std::size_t j = 0; j < 5; ++j) r.thetaTrue[j] = twin::Rig::PARAM_NOMINAL[j] * (1.0 + paramError * sign[j]);
    twin::RigPlant rig;
    Rng rng;
    std::array<double, 2> x{ 0.0, 0.0 };
    const double sampleDt = 0.008, h = 0.001;
    const int sub = 8;
    const int samples = static_cast<int>(seconds / sampleDt);
    double t = 0.0;
    for (int k = 0; k <= samples; ++k) {
        const double rpmCmd = kStairs[static_cast<int>(t / 2.5) % 12];
        const double v = k == 0 ? 0.0 : drive_volts(rpmCmd);
        if (k > 0) {
            for (int s = 0; s < sub; ++s) {
                twin::rk4_step(rig, t, x, std::span<const double>(r.thetaTrue), twin::RigInput{v}, h);
                for (std::size_t i = 0; i < 2; ++i) x[i] += std::sqrt(twin::Rig::PROCESS_NOISE[i] * h) * rng.normal();
                t += h;
            }
        }
        std::array<double, 3> y{};
        rig.outputs_p<double>(std::span<const double>(x), std::span<const double>(r.thetaTrue), twin::RigInput{v},
                              std::span<double>(y));
        for (std::size_t c = 0; c < 3; ++c) y[c] += twin::Rig::SENSOR_SIGMA[c] * rng.normal();
        r.t.push_back(t);
        r.v.push_back(v);
        r.z.push_back(y);
    }
    return r;
}

struct FilterStats {
    double nisSum{0}, dofSum{0};
    int windows{0}, consistent{0}, mismatch{0};
};

FilterStats filter(TwinEstimator& ekf, const Run& r, std::size_t from, std::size_t to) {
    FilterStats st;
    const double* ro = reinterpret_cast<const double*>(ekf.readoutPtr());
    using RL = twin::ReadoutLayout;
    for (std::size_t k = from; k < to; ++k) {
        if (k > 0) ekf.predict(r.t[k] - r.t[k - 1], r.v[k]);
        for (int c = 0; c < 3; ++c) ekf.setMeasurement(c, r.z[k][static_cast<std::size_t>(c)]);
        const double nis = ekf.update();
        if (nis >= 0) {
            st.nisSum += nis;
            st.dofSum += ro[RL::DOF];
        }
        if (ro[RL::WIN_COUNT] >= static_cast<double>(twin::kNisWindow) && k % twin::kNisWindow == 0) {
            ++st.windows;
            st.consistent += ro[RL::CONSISTENT] > 0.5 ? 1 : 0;
            st.mismatch += static_cast<int>(ro[RL::DIAGNOSIS]) == static_cast<int>(twin::Diagnosis::ModelMismatch) ? 1 : 0;
        }
    }
    return st;
}

void set_theta(TwinEstimator& ekf, const double* th) {
    for (int j = 0; j < 5; ++j) ekf.setParam(j, th[j]);
}

void load_run(TwinSysId& id, const Run& r, bool rpmOnly) {
    const std::size_t n = r.t.size();
    double* d = reinterpret_cast<double*>(id.dataPtr(static_cast<int>(n)));
    for (std::size_t k = 0; k < n; ++k) {
        d[k * 5 + 0] = r.t[k];
        d[k * 5 + 1] = r.v[k];
        for (std::size_t c = 0; c < 3; ++c) d[k * 5 + 2 + c] = (rpmOnly && c > 0) ? NAN : r.z[k][c];
    }
    const int err = id.load(static_cast<int>(n));
    if (err != 0) std::printf("twin.load error=%d %s\n", err, id.errorText());
}

} // namespace

int run_ad() {
    g_fail = 0;
    {
        HomopolarState st;
        HomopolarPlant p(st);
        for (const auto& x : { std::array<double, 2>{ 10.0, 5.0 }, std::array<double, 2>{ 200.0, 800.0 },
                               std::array<double, 2>{ 377.0, 1500.0 } }) {
            check_plant("homopolar", p, 0.0, x, HomopolarInput{ 0.9f });
        }
    }
    {
        ThomsonState st;
        ThomsonPlant p(st);
        const ThomsonInput u{ 0.3, 2.0 * 3.141592653589793 * 60.0, static_cast<double>(st.vPeak) * 0.85 };
        for (const auto& x : { std::array<double, 4>{ 3.0, -40.0, 0.1, 0.005 },
                               std::array<double, 4>{ -5.0, 60.0, -0.2, 0.02 },
                               std::array<double, 4>{ 0.5, -5.0, 0.0, 0.0 } }) {
            check_plant("jumping-ring", p, 0.003, x, u);
        }
    }
    {
        twin::RigPlant rig;
        for (const auto& x : { std::array<double, 2>{ 10.0, 0.5 }, std::array<double, 2>{ 60.0, 0.9 },
                               std::array<double, 2>{ -5.0, -0.2 } }) {
            check_plant("rig", rig, 0.0, x, twin::RigInput{ 7.5 });
            check_rig_sensitivities(rig, x, 7.5);
        }
    }
    std::printf("ad.done fail=%d\n", g_fail);
    return g_fail ? 1 : 0;
}

int run_twin() {
    g_fail = 0;
    const Run run = make_run(0.2, 30.0);
    const std::size_t n = run.t.size();
    double nominal[5];
    for (int j = 0; j < 5; ++j) nominal[j] = twin::Rig::PARAM_NOMINAL[static_cast<std::size_t>(j)];

    // 1. The true model: χ²-consistent.
    {
        TwinEstimator ekf;
        set_theta(ekf, run.thetaTrue.data());
        ekf.reset();
        const FilterStats st = filter(ekf, run, 0, n);
        const double lo = twin::chi2_quantile(st.dofSum, -twin::kZ975), hi = twin::chi2_quantile(st.dofSum, twin::kZ975);
        check("twin", "true.nis_per_dof", st.nisSum / st.dofSum, hi / st.dofSum, st.nisSum >= lo && st.nisSum <= hi);
        const double frac = st.windows ? static_cast<double>(st.consistent) / st.windows : 0.0;
        check("twin", "true.consistent_windows", frac, 0.8, frac >= 0.8);
    }
    // 2. The nominal model (±20 % off): inconsistent, diagnosed as the model.
    {
        TwinEstimator ekf;
        set_theta(ekf, nominal);
        ekf.reset();
        const FilterStats st = filter(ekf, run, 0, n);
        check("twin", "nominal.nis_per_dof", st.nisSum / st.dofSum, 3.0, st.nisSum / st.dofSum > 3.0);
        const double frac = st.windows ? static_cast<double>(st.mismatch) / st.windows : 0.0;
        check("twin", "nominal.mismatch_windows", frac, 0.8, frac >= 0.8);
    }
    // 3. Calibrate from nominal: every θ within 5 %.
    std::array<double, 5> fitted{};
    {
        TwinSysId id;
        load_run(id, run, false);
        for (int j = 0; j < 5; ++j) id.setParam(j, nominal[j]);
        id.setInitialState(0, run.z[0][0] * 3.141592653589793 / 30.0);
        id.setInitialState(1, run.z[0][1]);
        int status = id.start();
        while (status == static_cast<int>(twin::FitStatus::Running)) status = id.iterate();
        check("twin", "fit.status", status, static_cast<double>(twin::FitStatus::Converged),
              status == static_cast<int>(twin::FitStatus::Converged));
        double worst = 0.0, worstZ = 0.0;
        for (int j = 0; j < 5; ++j) {
            fitted[static_cast<std::size_t>(j)] = id.param(j);
            const double err = std::fabs(id.param(j) / run.thetaTrue[static_cast<std::size_t>(j)] - 1.0);
            const double sd = std::sqrt(id.covariance(j, j));
            std::printf("twin.param %s true=%.6e fit=%.6e sigma=%.3e err=%.3e\n", twin::Rig::PARAM_NAMES[j],
                        run.thetaTrue[static_cast<std::size_t>(j)], id.param(j), sd, err);
            worst = std::max(worst, err);
            worstZ = std::max(worstZ, std::fabs(id.param(j) - run.thetaTrue[static_cast<std::size_t>(j)]) / sd);
        }
        std::printf("twin.fit reduced_chi2=%.3f residual_rho=%.3f condition=%.3e\n", id.reducedChi2(),
                    id.residualAutocorr(), id.condition());
        // The reported σ is not wildly optimistic (one seed; a 24-seed Monte
        // Carlo gives z-RMS 0.9–1.3 — ADR-0019).
        check("twin", "fit.worst_error_in_sigma", worstZ, 4.0, worstZ <= 4.0);
        check("twin", "fit.worst_param_error", worst, 0.05, worst <= 0.05);
        check("twin", "fit.iterations", id.iterations(), 60, id.iterations() < 60);
        check("twin", "fit.warnings", static_cast<double>(id.warnings()), 0, id.warnings() == 0u);
        double r2min = 1.0;
        for (int c = 0; c < 3; ++c) r2min = std::min(r2min, id.r2(c));
        check("twin", "fit.r2_min", r2min, 0.99, r2min >= 0.99);
    }
    // 4. RPM alone cannot separate five parameters.
    {
        TwinSysId id;
        load_run(id, run, true);
        for (int j = 0; j < 5; ++j) id.setParam(j, nominal[j]);
        int status = id.start();
        while (status == static_cast<int>(twin::FitStatus::Running)) status = id.iterate();
        const std::uint32_t paramBits = id.warnings() & 0x1fu;
        check("twin", "rpm_only.unidentified_params", static_cast<double>(__builtin_popcount(paramBits)), 1,
              __builtin_popcount(paramBits) >= 1);
    }
    // 5. The calibrated filter is consistent again.
    {
        TwinEstimator ekf;
        set_theta(ekf, fitted.data());
        ekf.reset();
        const FilterStats st = filter(ekf, run, 0, n);
        const double frac = st.windows ? static_cast<double>(st.consistent) / st.windows : 0.0;
        check("twin", "calibrated.consistent_windows", frac, 0.8, frac >= 0.8);
    }
    // 6. Snapshot mid-run → restore → bit-identical continuation.
    {
        TwinEstimator a;
        set_theta(a, run.thetaTrue.data());
        a.reset();
        const std::size_t mid = n / 2;
        filter(a, run, 0, mid);
        a.save();
        std::vector<double> snap(static_cast<std::size_t>(a.snapshotCount()));
        const double* sp = reinterpret_cast<const double*>(a.snapshotPtr());
        std::copy(sp, sp + snap.size(), snap.begin());
        filter(a, run, mid, n);
        TwinEstimator b;
        double* bp = reinterpret_cast<double*>(b.snapshotPtr());
        std::copy(snap.begin(), snap.end(), bp);
        const bool loaded = b.load();
        filter(b, run, mid, n);
        bool same = loaded && a.time() == b.time();
        for (int i = 0; i < 2; ++i) {
            same = same && a.state(i) == b.state(i);
            for (int j = 0; j < 2; ++j) same = same && a.cov(i, j) == b.cov(i, j);
        }
        check("twin", "snapshot.bit_identical", same ? 1 : 0, 1, same);
        // A corrupted block is refused, not misread.
        bp[1] = 7.0;
        check("twin", "snapshot.bad_layout_refused", b.load() ? 1 : 0, 0, !b.load());
    }
    std::printf("twin.done fail=%d samples=%zu\n", g_fail, n);
    return g_fail ? 1 : 0;
}

#endif // SIM_CORE_STANDALONE

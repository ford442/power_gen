// =============================================================
// standalone_integrators.cpp  –  --mode integrators
//
// Holds every shared-integrator plant (core/integrate.h) to the reference it
// replaced. For each plant and method, run the plant's golden schedule twice:
// once on the reference (jumping-ring: the 20k-substep-per-second RK4 it has
// always used; homopolar: one RK4 step per frame), once on the method,
// and compare every ODE state at every frame:
//
//   err_i = max_frames |x_i − ref_i| / max_frames |ref_i|
//
// i.e. relative to the channel's own amplitude over the run (an AC current is
// compared against its peak, not against a sample near a zero crossing).
// Prints, per case,
//
//   integrators.case <plant> method=<m> frames=… rhs=… ref_rhs=… ratio=…
//                    steps=… rejected=… jac=… n=… err.<state>=… err.max=…
//
// `jac` counts ros23 Jacobian builds. Every shared-integrator plant is a
// DifferentiablePlant, so those are Dual evaluations, not RHS calls: the TS
// mirror (forward differences) spends n more RHS per Jacobian on the same path.
//
// and fails when the plant's *catalog* adaptive method misses its budget:
// ≥ 10× fewer RHS evaluations than the reference, err.max ≤ 5e-4 (issue
// #254: "about 1e-4", with the ring current the hardest channel — see
// docs/INTEGRATORS.md for the per-channel numbers). `npm run test:integrators`
// parses this and runs the TS mirror over the same schedule.
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <span>
#include <vector>

namespace {

constexpr double kMinRatio = 10.0;
constexpr double kMaxErr = 5e-4;

struct Trace {
    std::vector<std::array<float, 4>> x;
    double rhs{0}, steps{0}, rejected{0}, jacobians{0};
};

using Getter = void (*)(const SEGSimulator&, std::array<float, 4>&);

Trace run(int mode, float drive, int frames, float dt, int integrator, Getter get) {
    SEGSimulator sim;
    sim.setMode(mode);
    sim.setDrive(drive);
    sim.setIntegrator(integrator);
    sim.resetOdeStats();
    Trace tr;
    tr.x.reserve(static_cast<std::size_t>(frames));
    for (int i = 0; i < frames; ++i) {
        sim.step(dt, 0.f);
        std::array<float, 4> x{};
        get(sim, x);
        tr.x.push_back(x);
    }
    tr.rhs = sim.getOdeRhsEvals();
    tr.steps = sim.getOdeSteps();
    tr.rejected = sim.getOdeRejected();
    tr.jacobians = sim.getOdeJacobians();
    return tr;
}

struct PlantCase {
    const char* id;
    int mode;
    float drive;
    int frames;
    float dt;
    int nState;
    const char* const* names;
    sim_core::Integrator catalog;
    Getter get;
};

void ring_get(const SEGSimulator& s, std::array<float, 4>& x) {
    x = { s.getRingPrimaryIA(), s.getRingCurrentA(), s.getRingVelocityMps(), s.getRingHeightM() };
}
void disc_get(const SEGSimulator& s, std::array<float, 4>& x) {
    x = { s.getHomopolarOmega(), s.getHomopolarCurrentA(), 0.f, 0.f };
}

int compare(const PlantCase& pc, int method, const Trace& ref, double& ratioOut, double& errOut) {
    const Trace tr = run(pc.mode, pc.drive, pc.frames, pc.dt, method, pc.get);
    std::array<double, 4> amp{}, err{};
    for (const auto& r : ref.x) {
        for (int i = 0; i < pc.nState; ++i) amp[i] = std::max(amp[i], std::fabs(static_cast<double>(r[i])));
    }
    bool finite = true;
    for (std::size_t f = 0; f < tr.x.size(); ++f) {
        for (int i = 0; i < pc.nState; ++i) {
            const double v = tr.x[f][i];
            if (!std::isfinite(v)) finite = false;
            const double d = std::fabs(v - static_cast<double>(ref.x[f][i]));
            err[i] = std::max(err[i], amp[i] > 0 ? d / amp[i] : d);
        }
    }
    double errMax = 0;
    for (int i = 0; i < pc.nState; ++i) errMax = std::max(errMax, err[i]);
    const double ratio = tr.rhs > 0 ? ref.rhs / tr.rhs : 0;
    std::printf("integrators.case %s method=%s frames=%d dt=%.17g drive=%.17g rhs=%.0f ref_rhs=%.0f ratio=%.3f"
                " steps=%.0f rejected=%.0f jac=%.0f n=%d",
                pc.id, sim_core::integrator_name(static_cast<sim_core::Integrator>(method)), pc.frames,
                static_cast<double>(pc.dt), static_cast<double>(pc.drive), tr.rhs, ref.rhs, ratio,
                tr.steps, tr.rejected, tr.jacobians, pc.nState);
    for (int i = 0; i < pc.nState; ++i) std::printf(" err.%s=%.3e", pc.names[i], err[i]);
    std::printf(" err.max=%.3e\n", errMax);
    ratioOut = ratio;
    errOut = errMax;
    return finite ? 0 : 1;
}

// ── Analytic problems: the integrators against closed forms ─────────────

/// x'' = −ω²x as [x, v]; exact x = cos(ωt).
struct Oscillator {
    struct In { double omega; };
    using input_type = In;
    static constexpr std::size_t state_size = 2, output_size = 0;
    void derivs(double, std::span<const float> x, const In& u, std::span<float> d) const {
        d[0] = x[1];
        d[1] = static_cast<float>(-u.omega * u.omega) * x[0];
    }
    void outputs(std::span<const float>, const In&, std::span<float>) const {}
    void save(std::span<float>) const {}
    void load(std::span<const float>) {}
};

/// x' = −λ(x − cos t) − sin t, exact x = cos t (after the λ transient). Stiff
/// for λ = 1e4: an explicit method needs h < ~3/λ, an L-stable one does not.
struct StiffLinear {
    struct In { double t0; double lambda; };
    using input_type = In;
    static constexpr std::size_t state_size = 1, output_size = 0;
    void derivs(double t, std::span<const float> x, const In& u, std::span<float> d) const {
        const double tt = u.t0 + t;
        d[0] = static_cast<float>(-u.lambda * (static_cast<double>(x[0]) - std::cos(tt)) - std::sin(tt));
    }
    void outputs(std::span<const float>, const In&, std::span<float>) const {}
    void save(std::span<float>) const {}
    void load(std::span<const float>) {}
};

/// x' = x, exact e^t — for the RK4 convergence order.
struct Growth {
    struct In {};
    using input_type = In;
    static constexpr std::size_t state_size = 1, output_size = 0;
    void derivs(double, std::span<const float> x, const In&, std::span<float> d) const { d[0] = x[0]; }
    void outputs(std::span<const float>, const In&, std::span<float>) const {}
    void save(std::span<float>) const {}
    void load(std::span<const float>) {}
};

static_assert(sim_core::Plant<Oscillator> && sim_core::Plant<StiffLinear> && sim_core::Plant<Growth>);
static_assert(sim_core::ConstrainedPlant<ThomsonPlant> && sim_core::ConstrainedPlant<HomopolarPlant>);
static_assert(!sim_core::ConstrainedPlant<Oscillator>);

int analytic_checks() {
    int bad = 0;
    auto check = [&](bool ok, const char* what, double got, double limit) {
        std::printf("integrators.analytic %s value=%.3e limit=%.3e %s\n", what, got, limit, ok ? "ok" : "FAIL");
        if (!ok) bad = 1;
    };
    const double dt = 1.0 / 60.0;
    const int frames = 600; // 10 s, 10 periods at ω = 2π

    // dopri5 / ros23 across frame boundaries: dense output must keep phase.
    for (auto m : { sim_core::Integrator::Dopri5, sim_core::Integrator::Ros23 }) {
        Oscillator osc;
        const Oscillator::In u{2.0 * 3.14159265358979323846};
        sim_core::Tolerance<2> tol;
        tol.rtol = m == sim_core::Integrator::Dopri5 ? 1e-6f : 1e-5f;
        tol.atol = { 1e-7f, 1e-7f };
        sim_core::StepperState st;
        float x[2] = { 1.f, 0.f };
        double errMax = 0;
        sim_core::StepStats total;
        for (int f = 1; f <= frames; ++f) {
            total += sim_core::advance_adaptive(m, osc, std::span<float>(x), u, dt, tol, st);
            errMax = std::max(errMax, std::fabs(static_cast<double>(x[0]) - std::cos(u.omega * f * dt)));
        }
        const double limit = m == sim_core::Integrator::Dopri5 ? 1e-4 : 2e-2;
        char what[64];
        std::snprintf(what, sizeof what, "oscillator.%s.err", sim_core::integrator_name(m));
        check(total.ok && errMax <= limit, what, errMax, limit);
    }

    // Stiff: ros23 takes steps the accuracy wants; dopri5 is held to ~3/λ.
    {
        StiffLinear p;
        sim_core::Tolerance<1> tol;
        tol.rtol = 1e-4f;
        tol.atol = { 1e-6f };
        double steps[2] = { 0, 0 }, err[2] = { 0, 0 };
        int k = 0;
        for (auto m : { sim_core::Integrator::Dopri5, sim_core::Integrator::Ros23 }) {
            sim_core::StepperState st;
            float x[1] = { 1.f };
            for (int f = 0; f < 60; ++f) {
                const StiffLinear::In u{f * dt, 1e4};
                const auto s = sim_core::advance_adaptive(m, p, std::span<float>(x), u, dt, tol, st);
                steps[k] += s.steps;
                err[k] = std::max(err[k], std::fabs(static_cast<double>(x[0]) - std::cos((f + 1) * dt)));
            }
            ++k;
        }
        check(err[1] <= 1e-3, "stiff.ros23.err", err[1], 1e-3);
        check(err[0] <= 1e-3, "stiff.dopri5.err", err[0], 1e-3);
        // dopri5 needs ~λ/3.3 ≈ 3000 steps per second; ros23 a few dozen.
        check(steps[1] * 20 <= steps[0], "stiff.ros23_vs_dopri5.step_ratio", steps[0] / std::max(1.0, steps[1]), 20);
    }

    // RK4 is fourth order: halving h cuts the error ~16×.
    {
        Growth g;
        auto errAt = [&](int n) {
            float x[1] = { 1.f };
            const float h = 2.f / static_cast<float>(n);
            for (int i = 0; i < n; ++i) sim_core::rk4_fixed(g, 0.0, h, std::span<float>(x), Growth::In{});
            return std::fabs(static_cast<double>(x[0]) - std::exp(2.0));
        };
        const double ratio = errAt(8) / std::max(errAt(16), 1e-12);
        check(ratio > 12 && ratio < 20, "rk4.order_ratio", ratio, 16);
    }
    return bad;
}

} // namespace

int run_integrators() {
    static const char* const kRing[] = { "primaryIA", "ringCurrentA", "velocityMps", "heightM" };
    static const char* const kDisc[] = { "omega", "currentA" };
    // Same schedules as the golden cases (standalone_golden.cpp).
    const PlantCase cases[] = {
        { "jumping-ring", SIM_MODE_JUMPING_RING, 0.85f, 400, 1.f / 90.f, 4, kRing,
          power_gen::ode::JumpingRing::INTEGRATOR, ring_get },
        { "homopolar", SIM_MODE_HOMOPOLAR, 0.90f, 240, 1.f / 60.f, 2, kDisc,
          power_gen::ode::Homopolar::INTEGRATOR, disc_get },
    };
    int bad = analytic_checks();
    for (const PlantCase& pc : cases) {
        // Reference: the ring's own 20k-substep RK4; for the disc (one Euler
        // step per frame in the catalog) RK4 per frame is the reference.
        const Trace ref = run(pc.mode, pc.drive, pc.frames, pc.dt, 1, pc.get);
        for (int m : { 0, 1, 2, 3 }) {
            double ratio = 0, err = 0;
            bad |= compare(pc, m, ref, ratio, err);
            const auto method = static_cast<sim_core::Integrator>(m);
            const bool adaptive = method == sim_core::Integrator::Dopri5 || method == sim_core::Integrator::Ros23;
            if (adaptive && method == pc.catalog && (ratio < kMinRatio || !(err <= kMaxErr))) {
                std::fprintf(stderr, "FAIL: %s catalog method %s: ratio %.2f (need ≥ %.0f), err.max %.2e (need ≤ %.0e)\n",
                             pc.id, sim_core::integrator_name(method), ratio, kMinRatio, err, kMaxErr);
                bad = 1;
            }
        }
    }
    if (bad) return 1;
    std::printf("integrators.done budget.ratio=%.0f budget.err=%.0e\n", kMinRatio, kMaxErr);
    return 0;
}

#endif // SIM_CORE_STANDALONE

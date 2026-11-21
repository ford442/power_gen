// =============================================================
// standalone_circuit.cpp  –  --mode circuit | circuit-json (#256, ADR-0018)
//
// Golden circuits with analytic answers, run through the MNA solver exactly
// as the lab runs it: a fixed host step, one CircuitSim::step() per substep.
//
//   circuit        table + exit code (Makefile `native`, npm run validate)
//   circuit-json   every case's packed netlist, schedule and sampled probes,
//                  so scripts/tests/circuit.test.mjs replays them in WASM
//                  (parity) and re-judges the LC-energy and RLC-Q claims on
//                  the shipped binary.
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "sim_core.h"
#include "standalone/standalone_modes.h"
#include "standalone/circuit_golden.h"

#include <algorithm>
#include <complex>
#include <cstdio>
#include <string>
#include <vector>

using namespace circuit_golden;
using circuit::Kind;

namespace {

struct Event { int step; int elem; int index; double value; };
struct Probe { bool node; int index; };

struct Case {
    const char* id;
    const char* claim;
    NetBuilder net;
    double hostStep{1e-5};
    int steps{0};
    std::vector<Probe> probes;
    std::vector<Event> events;
};

struct Trace {
    std::vector<double> t, stored;
    std::vector<std::vector<double>> ch;
    int errors{0};
    double stat[circuit::ST_COUNT]{};
    // Energy books per host step (readout header): Σ|W_src − W_diss − ΔE|
    // (ΔE the true ½Cv² + ½Li² + M·i₁i₂ change) against the energy moved,
    // ½ Σ_elements |∫v·i| — Tellegen's theorem on the discrete solution, so
    // what is left is the trapezoid's O(h³) per step: ≈ (ω h)²/8 relative.
    double residualAbs{0}, flowAbs{0};
};

struct Measured { const char* key; double value; };
struct Verdict {
    bool pass{true};
    std::string detail;
    std::vector<Measured> measured;
};

Trace run(const Case& c) {
    circuit::CircuitSim sim;
    const std::vector<float> packed = c.net.pack();
    Trace tr;
    tr.ch.assign(c.probes.size(), {});
    if (sim.load(packed.data(), static_cast<int>(packed.size())) != circuit::OK) {
        std::printf("  load failed: %s\n", sim.errorText());
        tr.errors = 1;
        return tr;
    }
    auto sample = [&]() {
        tr.t.push_back(sim.time());
        tr.stored.push_back(sim.storedEnergy());
        for (std::size_t k = 0; k < c.probes.size(); ++k) {
            const Probe& p = c.probes[k];
            tr.ch[k].push_back(p.node ? sim.nodeVoltage(p.index) : sim.elemCurrent(p.index));
        }
    };
    sample();
    for (int s = 0; s < c.steps; ++s) {
        for (const Event& e : c.events) if (e.step == s) sim.setParam(e.elem, e.index, e.value);
        if (sim.step(c.hostStep) < 0) {
            ++tr.errors;
            std::printf("  step %d: %s\n", s, sim.errorText());
            break;
        }
        const double* ro = reinterpret_cast<const double*>(sim.readoutPtr());
        const double dE = ro[circuit::RO_STORED] - ro[circuit::RO_STORED_START];
        tr.residualAbs += std::abs(ro[circuit::RO_W_SOURCE] - ro[circuit::RO_W_DISSIPATED] - dE);
        const double* rows = ro + circuit::RO_HEADER + sim.nodeCount();
        double through = 0.0;
        for (int e = 0; e < sim.elemCount(); ++e) through += std::abs(rows[e * circuit::READOUT_STRIDE + circuit::RE_WE]);
        tr.flowAbs += 0.5 * through; // every joule leaves one element and enters another
        sample();
    }
    for (int k = 0; k < circuit::ST_COUNT; ++k) tr.stat[k] = sim.stat(k);
    return tr;
}

std::size_t firstAt(const std::vector<double>& t, double t0) {
    return static_cast<std::size_t>(std::lower_bound(t.begin(), t.end(), t0) - t.begin());
}

void check(Verdict& v, bool ok, const char* what) {
    if (!ok) { v.pass = false; v.detail += what; v.detail += "; "; }
}

// ── cases ──────────────────────────────────────────────────────────────

Case rcCharge() {
    Case c{ "rc-charge", "RC step: v = 1 - exp(-t/RC), tau 1 ms", {}, 1e-5, 500, {}, {} };
    NetBuilder& n = c.net;
    const int a = n.node(), b = n.node();
    n.add(Kind::V, { a, 0 }, { 0, 1.0 });
    n.add(Kind::R, { a, b }, { 1000.0 });
    n.add(Kind::C, { b, 0 }, { 1e-6, 0.0 });
    c.probes = { { true, b } };
    return c;
}

Verdict judgeRc(const Case&, const Trace& tr) {
    Verdict v;
    const double tau = f32(1000.0) * f32(1e-6);
    double errMax = 0.0, sxy = 0.0, sxx = 0.0;
    for (std::size_t k = 0; k < tr.t.size(); ++k) {
        const double t = tr.t[k], y = tr.ch[0][k];
        errMax = std::max(errMax, std::abs(y - (1.0 - std::exp(-t / tau))));
        if (t >= 0.5 * tau && t <= 4.0 * tau) { const double l = std::log(1.0 - y); sxy += t * l; sxx += t * t; }
    }
    const double tauFit = -sxx / sxy; // ln(1 − v) = −t/τ through the origin
    v.measured = { { "maxAbsError", errMax }, { "tauFitS", tauFit }, { "tauS", tau },
                   { "factors", tr.stat[circuit::ST_FACTORS] }, { "reused", tr.stat[circuit::ST_REUSED] } };
    check(v, errMax < 2e-4, "max |v - exact| >= 2e-4");
    check(v, std::abs(tauFit / tau - 1.0) < 1e-3, "tau fit off by >= 0.1 %");
    // A linear circuit at a steady step factors a handful of times (start,
    // BE ramp) and then only substitutes.
    check(v, tr.stat[circuit::ST_FACTORS] <= 24 && tr.stat[circuit::ST_REUSED] >= 0.9 * tr.stat[circuit::ST_STEPS],
          "linear circuit did not reuse its factorisation");
    return v;
}

Case rlcRing() {
    Case c{ "rlc-ring", "series RLC from a charged C: f_d and Q = sqrt(L/C)/R", {}, 1e-5, 4000, {}, {} };
    NetBuilder& n = c.net;
    const int a = n.node(), b = n.node();
    n.add(Kind::C, { a, 0 }, { 10e-6, 10.0 });
    const int l = n.add(Kind::L, { a, b }, { 10e-3, 0.0 });
    n.add(Kind::R, { b, 0 }, { 1.0 });
    c.probes = { { true, a }, { false, l } };
    return c;
}

Verdict judgeRlc(const Case& c, const Trace& tr) {
    Verdict v;
    using cd = std::complex<double>;
    const double PI = 3.14159265358979323846;
    const double L = f32(10e-3), C = f32(10e-6), R = f32(1.0), V0 = f32(10.0);
    const double alpha = R / (2.0 * L), w0 = 1.0 / std::sqrt(L * C), wd = std::sqrt(w0 * w0 - alpha * alpha);
    const double Q = std::sqrt(L / C) / R;
    // The trapezoidal rule maps the pole s to z = (1 + sh/2)/(1 − sh/2): it
    // keeps |z| (no numerical damping) and warps the phase by ≈ (ω h)²/12.
    // Its exact discrete answer is the closed form with those parameters.
    const double h = c.hostStep;
    const cd s(-alpha, wd);
    const cd z = (1.0 + s * h / 2.0) / (1.0 - s * h / 2.0);
    const double wdTr = std::arg(z) / h, alphaTr = -std::log(std::abs(z)) / h;
    double errExact = 0.0, errTr = 0.0;
    // From the first step: under UIC the node voltages at t = 0 are not
    // solved (the capacitor's ic is its own state, not a node value).
    for (std::size_t k = 1; k < tr.t.size(); ++k) {
        const double t = tr.t[k];
        const double exact = V0 * std::exp(-alpha * t) * (std::cos(wd * t) + alpha / wd * std::sin(wd * t));
        const double trExact = V0 * std::exp(-alphaTr * t) * (std::cos(wdTr * t) + alphaTr / wdTr * std::sin(wdTr * t));
        errExact = std::max(errExact, std::abs(tr.ch[0][k] - exact) / V0);
        errTr = std::max(errTr, std::abs(tr.ch[0][k] - trExact) / V0);
    }
    const std::vector<double> zc = risingCrossings(tr.t, tr.ch[1]);
    const double fd = zc.size() >= 2 ? (static_cast<double>(zc.size()) - 1.0) / (zc.back() - zc.front()) : 0.0;
    const auto pk = peaks(tr.t, tr.ch[1]);
    double aSum = 0.0;
    int aN = 0;
    for (std::size_t k = 0; k + 1 < pk.size() && k < 8; ++k) {
        aSum += std::log(pk[k].second / pk[k + 1].second) / (pk[k + 1].first - pk[k].first);
        ++aN;
    }
    const double aMeas = aN ? aSum / aN : 0.0;
    const double wdMeas = 2.0 * PI * fd;
    const double qMeas = aMeas > 0.0 ? std::sqrt(wdMeas * wdMeas + aMeas * aMeas) / (2.0 * aMeas) : 0.0;
    const double fdExact = wd / (2.0 * PI), fdTr = wdTr / (2.0 * PI);
    v.measured = { { "maxRelError", errExact }, { "maxRelErrorVsTr", errTr }, { "fdHz", fd }, { "fdExactHz", fdExact },
                   { "fdTrHz", fdTr }, { "Q", qMeas }, { "Qexact", Q } };
    check(v, errExact < 3e-3, "|v_C - closed form| / V0 >= 3e-3 over 20 periods");
    check(v, errTr < 2e-4, "|v_C - trapezoidal closed form| / V0 >= 2e-4");
    check(v, std::abs(fd / fdExact - 1.0) < 1e-3, "ring frequency off by >= 0.1 %");
    check(v, std::abs(fd / fdTr - 1.0) < 1e-5, "ring frequency is not the trapezoidal rule's");
    check(v, std::abs(qMeas / Q - 1.0) < 2e-3, "Q off by >= 0.2 %");
    return v;
}

Case halfWave() {
    Case c{ "halfwave-ripple", "half-wave + RC: exponential discharge between peaks; ripple ~ Vpk/(fRC)", {}, 2e-5, 75000, {}, {} };
    NetBuilder& n = c.net;
    const int s = n.node(), o = n.node();
    n.add(Kind::V, { s, 0 }, { 1, 0.0, 10.0, 60.0, 0.0, 0.0, 0.0 });
    n.add(Kind::D, { s, o }, { 1e-14, 1.0, 0.0 });
    n.add(Kind::C, { o, 0 }, { 1e-3, 0.0 });
    n.add(Kind::R, { o, 0 }, { 1000.0 });
    c.probes = { { true, o } };
    return c;
}

Verdict judgeHalfWave(const Case&, const Trace& tr) {
    Verdict v;
    const double RC = f32(1000.0) * f32(1e-3), f = f32(60.0);
    const std::size_t from = firstAt(tr.t, 1.0);
    const std::vector<double>& y = tr.ch[0];
    double vMax = -1e9, vMin = 1e9;
    for (std::size_t k = from; k < y.size(); ++k) { vMax = std::max(vMax, y[k]); vMin = std::min(vMin, y[k]); }
    const double ripple = vMax - vMin, textbook = vMax / (f * RC);
    // One discharge: from a peak to the next minimum the cap only feeds R.
    std::size_t kPk = from;
    for (std::size_t k = from; k < from + static_cast<std::size_t>(1.0 / (f * 2e-5)); ++k) if (y[k] > y[kPk]) kPk = k;
    std::size_t kMin = kPk;
    while (kMin + 1 < y.size() && y[kMin + 1] < y[kMin]) ++kMin;
    // The diode still conducts just past the peak (its current falls off
    // smoothly), so the pure RC discharge is judged from a quarter of the way
    // into the interval, where the source is volts below the cap.
    double dev = 0.0;
    const std::size_t k0 = kPk + (kMin - kPk) / 4, guard = (kMin - kPk) / 20;
    for (std::size_t k = k0; k + guard < kMin; ++k) {
        dev = std::max(dev, std::abs(y[k] - y[k0] * std::exp(-(tr.t[k] - tr.t[k0]) / RC)));
    }
    v.measured = { { "vPeak", vMax }, { "rippleV", ripple }, { "textbookV", textbook }, { "dischargeDevV", dev } };
    check(v, std::abs(ripple / textbook - 1.0) < 0.1, "ripple not within 10 % of Vpk/(fRC)");
    check(v, dev < 1e-3 * ripple, "discharge leaves exp(-t/RC) by >= 0.1 % of the ripple");
    return v;
}

Case transformer() {
    Case c{ "transformer-ratio", "coupled L1/L2 (k 0.97), 12 ohm load: rms(Vs)/rms(Vp) = phasor answer = the plant", {}, 1.0 / 2400.0, 12000, {}, {} };
    NetBuilder& n = c.net;
    const int g = n.node(), p = n.node(), s1 = n.node(), s2 = n.node();
    n.add(Kind::V, { g, 0 }, { 1, 0.0, 28.0, 60.0, 0.0, 0.0, 0.0 });
    n.add(Kind::R, { g, p }, { 1.8 });
    const int l1 = n.add(Kind::L, { p, 0 }, { 0.85, 0.0 });
    const int l2 = n.add(Kind::L, { s1, 0 }, { 0.095, 0.0 });
    n.add(Kind::K, {}, { static_cast<double>(l1), static_cast<double>(l2), 0.97 });
    n.add(Kind::R, { s1, s2 }, { 0.45 });
    n.add(Kind::R, { s2, 0 }, { 12.0 });
    c.probes = { { true, g }, { true, s2 } };
    return c;
}

Verdict judgeTransformer(const Case& c, const Trace& tr) {
    Verdict v;
    using cd = std::complex<double>;
    const double w = 2.0 * 3.14159265358979323846 * f32(60.0);
    const double L1 = f32(0.85), L2 = f32(0.095), k = f32(0.97), R1 = f32(1.8), R2 = f32(0.45), RL = f32(12.0);
    const double M = k * std::sqrt(L1 * L2);
    const cd j(0.0, 1.0);
    // KVL: V = (R1 + jωL1)·i1 + jωM·i2;  0 = jωM·i1 + (R2 + RL + jωL2)·i2;  Vs = −RL·i2.
    const cd z1 = R1 + j * w * L1, z2 = R2 + RL + j * w * L2, zm = j * w * M;
    const cd i1 = cd(1.0) / (z1 - zm * zm / z2);
    const cd i2 = -zm * i1 / z2;
    const double phasor = std::abs(RL * i2);
    const std::size_t from = firstAt(tr.t, 4.0);
    const double ratio = rms(tr.ch[1], from) / rms(tr.ch[0], from);

    // The transformer plant (transformer_plant.cpp) integrates the same ODE.
    SEGSimulator sim;
    sim.setMode(SIM_MODE_TRANSFORMER);
    sim.setDrive(1.f);
    std::vector<double> vp, vs;
    for (int s = 0; s < c.steps; ++s) {
        sim.step(static_cast<float>(c.hostStep), 0.f);
        if ((s + 1) * c.hostStep >= 4.0) { vp.push_back(sim.getTransformerV1()); vs.push_back(sim.getTransformerV2()); }
    }
    const double plant = rms(vs, 0) / rms(vp, 0);
    v.measured = { { "ratio", ratio }, { "phasor", phasor }, { "plant", plant }, { "turnsRatio", 40.0 / 120.0 } };
    check(v, std::abs(ratio / phasor - 1.0) < 2e-3, "circuit ratio not within 0.2 % of the phasor answer");
    check(v, std::abs(ratio / plant - 1.0) < 5e-3, "circuit ratio not within 0.5 % of the transformer plant");
    return v;
}

Case lcEnergy() {
    Case c{ "lc-energy", "lossless LC, 1000+ periods at a 1/60 s host step: energy within 1e-4", {}, 1.0 / 60.0, 40, {}, {} };
    NetBuilder& n = c.net;
    const int a = n.node();
    const int l = n.add(Kind::L, { a, 0 }, { 1e-3, 0.0 });
    n.add(Kind::C, { a, 0 }, { 10e-6, 1.0 });
    c.probes = { { true, a }, { false, l } };
    return c;
}

Verdict judgeLc(const Case&, const Trace& tr) {
    Verdict v;
    const double E0 = 0.5 * f32(10e-6) * 1.0;
    double dev = 0.0;
    for (double e : tr.stored) dev = std::max(dev, std::abs(e / E0 - 1.0));
    const double periods = tr.t.back() / (2.0 * 3.14159265358979323846 * std::sqrt(f32(1e-3) * f32(10e-6)));
    v.measured = { { "maxRelEnergyDev", dev }, { "periods", periods }, { "internalSteps", tr.stat[circuit::ST_STEPS] } };
    check(v, periods >= 1000.0, "fewer than 1000 periods");
    check(v, dev < 1e-4, "energy drifted >= 1e-4");
    return v;
}

Case flyback() {
    Case c{ "switch-flyback", "switch opens an inductor into a flyback diode: BE restart, monotone decay, no ringing", {}, 1e-5, 1500, {}, {} };
    NetBuilder& n = c.net;
    const int vv = n.node(), a = n.node(), m = n.node();
    n.add(Kind::V, { vv, 0 }, { 0, 12.0 });
    const int sw = n.add(Kind::S, { vv, a }, { 1e-3, 1e9, 1.0 });
    n.add(Kind::R, { a, m }, { 10.0 });
    const int l = n.add(Kind::L, { m, 0 }, { 10e-3, 0.0 });
    n.add(Kind::D, { 0, a }, { 1e-14, 1.0, 0.0 });
    c.probes = { { false, l }, { true, a } };
    c.events = { { 500, sw, 2, 0.0 } };
    return c;
}

Verdict judgeFlyback(const Case&, const Trace& tr) {
    Verdict v;
    const std::size_t open = 500;
    const double iOpen = tr.ch[0][open];
    const double expect = f32(12.0) / (f32(10.0) + f32(1e-3)) * (1.0 - std::exp(-0.005 * (f32(10.0) + f32(1e-3)) / f32(10e-3)));
    bool monotone = true;
    double vMin = 0.0, vMax = -1e9;
    for (std::size_t k = open + 1; k < tr.t.size(); ++k) {
        if (tr.ch[0][k] > tr.ch[0][k - 1] + 1e-9 || tr.ch[0][k] < -1e-6) monotone = false;
        if (k > open + 5) { vMin = std::min(vMin, tr.ch[1][k]); vMax = std::max(vMax, tr.ch[1][k]); }
    }
    v.measured = { { "iAtOpenA", iOpen }, { "iExpectedA", expect }, { "clampMinV", vMin }, { "clampMaxV", vMax },
                   { "beSteps", tr.stat[circuit::ST_BE_STEPS] } };
    check(v, std::abs(iOpen / expect - 1.0) < 1e-3, "inductor current at the switch event off by >= 0.1 %");
    check(v, monotone, "inductor current rang or rose after the switch opened");
    // While the inductor discharges, node a sits one diode drop below ground;
    // once its current is gone it settles near 0 V. TR ringing after the diode
    // cuts off would show as a ± step-to-step alternation of v_L (31 mV here
    // before the region-change restart).
    check(v, vMin > -1.2 && vMax < 1e-3, "flyback clamp not a diode drop, or v_L rang after cut-off");
    check(v, tr.stat[circuit::ST_BE_STEPS] >= 2, "no BE restart after the switch event");
    return v;
}

Case bridge() {
    Case c{ "bridge-rc", "full-wave bridge into RC: Newton converges every step; ripple ~ Vpk/(2fRC); symbolic LU reused", {}, 1e-4, 10000, {}, {} };
    NetBuilder& n = c.net;
    const int s = n.node(), t = n.node(), p = n.node();
    n.add(Kind::V, { s, t }, { 1, 0.0, 10.0, 50.0, 0.0, 0.0, 0.0 });
    n.add(Kind::D, { s, p }, { 1e-14, 1.0, 0.05 });
    n.add(Kind::D, { t, p }, { 1e-14, 1.0, 0.05 });
    n.add(Kind::D, { 0, s }, { 1e-14, 1.0, 0.05 });
    n.add(Kind::D, { 0, t }, { 1e-14, 1.0, 0.05 });
    n.add(Kind::C, { p, 0 }, { 1e-3, 0.0 });
    n.add(Kind::R, { p, 0 }, { 100.0 });
    c.probes = { { true, p } };
    return c;
}

/// Ideal-rectifier ripple for an effective drop vd: the cap follows the
/// envelope |vs sin ωt| − vd until it falls faster than v/RC allows, then
/// discharges as exp(−t/RC) until the next half-cycle catches it.
double bridgeRipple(double vs, double vd, double w, double rc) {
    auto bisect = [](auto f, double lo, double hi) {
        for (int k = 0; k < 200; ++k) { const double m = 0.5 * (lo + hi); (f(lo) > 0.0) == (f(m) > 0.0) ? lo = m : hi = m; }
        return 0.5 * (lo + hi);
    };
    const double PI = 3.14159265358979323846;
    const double th1 = bisect([&](double th) { return -vs * w * std::cos(th) * rc - (vs * std::sin(th) - vd); }, 0.5 * PI, PI);
    const double v1 = vs * std::sin(th1) - vd;
    const double th2 = bisect([&](double th) { return v1 * std::exp(-(th - th1) / (w * rc)) - (vs * std::abs(std::sin(th)) - vd); },
                              PI, 1.5 * PI);
    return (vs - vd) - v1 * std::exp(-(th2 - th1) / (w * rc));
}

Verdict judgeBridge(const Case&, const Trace& tr) {
    Verdict v;
    const std::size_t from = firstAt(tr.t, 0.6);
    double vMax = -1e9, vMin = 1e9;
    for (std::size_t k = from; k < tr.ch[0].size(); ++k) { vMax = std::max(vMax, tr.ch[0][k]); vMin = std::min(vMin, tr.ch[0][k]); }
    const double vs = f32(10.0), rc = f32(100.0) * f32(1e-3), w = 2.0 * 3.14159265358979323846 * f32(50.0);
    const double ripple = vMax - vMin, textbook = vMax / (2.0 * f32(50.0) * rc);
    const double ideal = bridgeRipple(vs, vs - vMax, w, rc);
    v.measured = { { "vPeak", vMax }, { "rippleV", ripple }, { "idealRippleV", ideal }, { "textbookV", textbook },
                   { "analyses", tr.stat[circuit::ST_ANALYSES] }, { "factors", tr.stat[circuit::ST_FACTORS] },
                   { "newtonPerStep", tr.stat[circuit::ST_NEWTON] / std::max(1.0, tr.stat[circuit::ST_STEPS]) } };
    check(v, tr.errors == 0, "a step failed");
    check(v, vMax > 8.0 && vMax < 9.2, "output peak is not Vpk minus two diode drops");
    // The textbook Vpk/(2fRC) assumes the cap discharges for the whole
    // half-cycle; the ideal-rectifier answer (a constant drop, the one
    // measured at the peak) knows when conduction resumes.
    // The real drop is smaller when conduction resumes (low current) than at
    // the peak, so the measured ripple sits a few % under the ideal one.
    check(v, std::abs(ripple / ideal - 1.0) < 0.1, "ripple not within 10 % of the ideal-rectifier answer");
    check(v, ripple < textbook, "ripple above the textbook bound Vpk/(2fRC)");
    check(v, tr.stat[circuit::ST_ANALYSES] <= 8 && tr.stat[circuit::ST_FACTORS] > 1000, "symbolic factorisation was not reused");
    return v;
}

Case dcCase(const char* id, const char* claim) {
    Case c{ id, claim, {}, 1e-4, 20, {}, {} };
    return c;
}

Case vcvs() {
    Case c = dcCase("vcvs-inverting", "VCVS op-amp (A = 1e5), Rf/Rin = 10: vo = -10 vi / (1 + 11/A)");
    NetBuilder& n = c.net;
    const int i = n.node(), m = n.node(), o = n.node();
    n.add(Kind::V, { i, 0 }, { 0, 0.5 });
    n.add(Kind::R, { i, m }, { 1000.0 });
    n.add(Kind::R, { m, o }, { 10000.0 });
    n.add(Kind::E, { o, 0, 0, m }, { 1e5 });
    c.probes = { { true, o } };
    return c;
}

Verdict judgeVcvs(const Case&, const Trace& tr) {
    Verdict v;
    const double A = f32(1e5), exact = -10.0 * f32(0.5) / (1.0 + 11.0 / A);
    const double vo = tr.ch[0].back();
    v.measured = { { "vo", vo }, { "exact", exact } };
    check(v, std::abs(vo / exact - 1.0) < 1e-7, "vo off by >= 1e-7");
    return v;
}

Case vccs() {
    Case c = dcCase("vccs", "VCCS gm 1 mS from 2 V into 1 kohm: 2 V");
    NetBuilder& n = c.net;
    const int cn = n.node(), o = n.node();
    n.add(Kind::V, { cn, 0 }, { 0, 2.0 });
    n.add(Kind::G, { 0, o, cn, 0 }, { 1e-3 });
    n.add(Kind::R, { o, 0 }, { 1000.0 });
    c.probes = { { true, o } };
    return c;
}

Verdict judgeVccs(const Case&, const Trace& tr) {
    Verdict v;
    const double exact = f32(1e-3) * f32(2.0) * f32(1000.0), vo = tr.ch[0].back();
    v.measured = { { "vo", vo }, { "exact", exact } };
    check(v, std::abs(vo / exact - 1.0) < 1e-6, "vo off by >= 1e-6");
    return v;
}

Case mosfets() {
    Case c = dcCase("mosfet-level1", "NMOS / PMOS level 1 in saturation: id = kp/2 (vgs - vt)^2 = 2 mA");
    NetBuilder& n = c.net;
    const int vdd = n.node(), dn = n.node(), g = n.node(), dp = n.node(), gp = n.node();
    n.add(Kind::V, { vdd, 0 }, { 0, 10.0 });
    n.add(Kind::R, { vdd, dn }, { 1000.0 });
    n.add(Kind::V, { g, 0 }, { 0, 3.0 });
    n.add(Kind::M, { dn, g, 0 }, { 1.0, 1.0, 1e-3, 0.0 });
    n.add(Kind::V, { gp, 0 }, { 0, 7.0 });
    n.add(Kind::M, { dp, gp, vdd }, { -1.0, 1.0, 1e-3, 0.0 });
    n.add(Kind::R, { dp, 0 }, { 1000.0 });
    c.probes = { { true, dn }, { true, dp } };
    return c;
}

Verdict judgeMosfets(const Case&, const Trace& tr) {
    Verdict v;
    const double vn = tr.ch[0].back(), vp = tr.ch[1].back();
    v.measured = { { "vDrainN", vn }, { "vDrainP", vp } };
    check(v, std::abs(vn - 8.0) < 1e-5, "NMOS drain not at 8 V");
    check(v, std::abs(vp - 2.0) < 1e-5, "PMOS drain not at 2 V");
    return v;
}

/// Every case: the window energy books close (the residual the energy
/// network reports for a wired edge is this number).
void judgeEnergyBooks(Verdict& v, const Trace& tr) {
    const double rel = tr.flowAbs > 0.0 ? tr.residualAbs / tr.flowAbs : 0.0;
    v.measured.push_back({ "energyResidualRel", rel });
    // Linear cases sit at 1e-5 or below; the bridge (diode current spikes at
    // a 100 us step) at ~1e-4. The issue's bar for a wired edge is 1 %.
    check(v, rel < 1e-3, "energy books do not close (|W_src - W_diss - dE| >= 1e-3 of the energy moved)");
}

struct Golden { Case (*make)(); Verdict (*judge)(const Case&, const Trace&); };

const Golden GOLDENS[] = {
    { rcCharge, judgeRc },         { rlcRing, judgeRlc },       { halfWave, judgeHalfWave },
    { transformer, judgeTransformer }, { lcEnergy, judgeLc },   { flyback, judgeFlyback },
    { bridge, judgeBridge },       { vcvs, judgeVcvs },         { vccs, judgeVccs },
    { mosfets, judgeMosfets },
};

} // namespace

int run_circuit() {
    int failed = 0;
    std::printf("circuit goldens (MNA, TR + BE restarts, Newton, dense LU)\n");
    for (const Golden& g : GOLDENS) {
        const Case c = g.make();
        const Trace tr = run(c);
        Verdict v = tr.errors ? Verdict{ false, "solver error", {} } : g.judge(c, tr);
        judgeEnergyBooks(v, tr);
        std::printf("  %-18s %s  %s\n", c.id, v.pass ? "PASS" : "FAIL", c.claim);
        for (const Measured& m : v.measured) std::printf("      %-18s %.9g\n", m.key, m.value);
        if (!v.pass) { std::printf("      -> %s\n", v.detail.c_str()); ++failed; }
    }
    if (failed) {
        std::printf("FAIL: %d circuit golden(s)\n", failed);
        return 1;
    }
    std::printf("circuit goldens OK\n");
    return 0;
}

int run_circuit_json() {
    std::printf("{\"format\":%d,\"kinds\":[", circuit::FORMAT_VERSION);
    for (int k = 0; k < circuit::KIND_COUNT; ++k) std::printf("%s\"%s\"", k ? "," : "", circuit::kind_name(k));
    std::printf("],\"cases\":[");
    bool firstCase = true;
    for (const Golden& g : GOLDENS) {
        const Case c = g.make();
        const Trace tr = run(c);
        Verdict v = tr.errors ? Verdict{ false, "solver error", {} } : g.judge(c, tr);
        judgeEnergyBooks(v, tr);
        std::printf("%s{\"id\":\"%s\",\"pass\":%s,\"hostStep\":%.17g,\"steps\":%d,\"packed\":[",
                    firstCase ? "" : ",", c.id, v.pass ? "true" : "false", c.hostStep, c.steps);
        firstCase = false;
        const std::vector<float> packed = c.net.pack();
        for (std::size_t k = 0; k < packed.size(); ++k) std::printf("%s%.9g", k ? "," : "", static_cast<double>(packed[k]));
        std::printf("],\"probes\":[");
        for (std::size_t k = 0; k < c.probes.size(); ++k) std::printf("%s{\"node\":%s,\"index\":%d}", k ? "," : "", c.probes[k].node ? "true" : "false", c.probes[k].index);
        std::printf("],\"events\":[");
        for (std::size_t k = 0; k < c.events.size(); ++k) std::printf("%s[%d,%d,%d,%.17g]", k ? "," : "", c.events[k].step, c.events[k].elem, c.events[k].index, c.events[k].value);
        std::printf("],\"measured\":{");
        for (std::size_t k = 0; k < v.measured.size(); ++k) std::printf("%s\"%s\":%.17g", k ? "," : "", v.measured[k].key, v.measured[k].value);
        // ~64 samples per case for the WASM parity check (step index, t, stored, probes…).
        const std::size_t every = std::max<std::size_t>(1, tr.t.size() / 64);
        std::printf("},\"samples\":[");
        bool firstSample = true;
        for (std::size_t k = 0; k < tr.t.size(); k += every) {
            std::printf("%s[%zu,%.17g,%.17g", firstSample ? "" : ",", k, tr.t[k], tr.stored[k]);
            for (const auto& ch : tr.ch) std::printf(",%.17g", ch[k]);
            std::printf("]");
            firstSample = false;
        }
        std::printf("]}");
    }
    std::printf("]}\n");
    return 0;
}

#endif // SIM_CORE_STANDALONE

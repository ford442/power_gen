// =============================================================
// circuit/transient.cpp  –  step(h): the internal time steps of one host step
//
// The host (the plant clock, one substep at a time) asks for h seconds. The
// solver walks there in internal steps:
//
//   • at most opt.maxStep, cut at every breakpoint (a PULSE corner, a
//     clocked switch edge) and spread evenly over what is left of the
//     interval, so a steady host step gives a steady internal step — and a
//     linear circuit keeps one factorisation for the whole run;
//   • trapezoidal by default; backward Euler for one short step at t = 0,
//     after every breakpoint, after a switch is toggled by setParam and
//     after a diode or MOSFET changes region (a diode cutting off an
//     inductor's current is a discontinuity no breakpoint announces), so
//     the trapezoidal rule's undamped ±ringing at a discontinuity never
//     starts, or dies after one step (the BE step is 1/1000 of the step it replaces, so its own
//     damping is negligible — the lossless-LC golden holds 1e-4 over 1000
//     periods);
//   • local truncation error per reactive state against an AB2 predictor
//     (TR's LTE ≈ (x_TR − x_AB2)/6), relative to the state's peak: a step
//     over tolerance is rejected and retried smaller; one far under it lets
//     the next step double (hysteresis, so the step — and the LU — settles);
//   • a Newton failure halves the step, down to opt.minStep (then an error,
//     with the state left at the last accepted point).
// =============================================================

#include "circuit.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

namespace circuit {

namespace {
constexpr double INF = std::numeric_limits<double>::infinity();
constexpr double BE_START_FRACTION = 1e-3;
constexpr double BE_GROWTH = 8.0;
constexpr int LTE_REJECT = 1;
constexpr double DIODE_VT = 0.025852; // kT/q at 300 K (stamps.cpp, newton.cpp)

double timeEps(double t) { return 1e-13 + 1e-12 * std::abs(t); }

bool isActive(Kind k) { return k == Kind::V || k == Kind::I || k == Kind::E || k == Kind::G; }
bool isDissipative(Kind k) { return k == Kind::R || k == Kind::D || k == Kind::S || k == Kind::M; }
} // namespace

double CircuitSim::_nextBreakpoint(double after) const {
    const double eps = timeEps(after);
    double best = INF;
    auto consider = [&](double t) { if (t > after + eps && t < best) best = t; };
    for (const Element& e : _el) {
        if ((e.kind == Kind::V || e.kind == Kind::I) && static_cast<int>(e.p[0]) == static_cast<int>(Wave::Pulse)) {
            const double td = e.p[3], tr = e.p[4], tf = e.p[5], pw = e.p[6], per = e.p[7];
            const double corners[4] = { 0.0, tr, tr + pw, tr + pw + tf };
            double k0 = 0.0;
            if (per > 0.0) k0 = std::max(0.0, std::floor((after - td) / per));
            for (int k = 0; k < 2; ++k) {
                const double base = td + (per > 0.0 ? (k0 + k) * per : 0.0);
                for (double c : corners) consider(base + c);
                if (!(per > 0.0)) break;
            }
        } else if (e.kind == Kind::S && e.p[3] > 0.0) {
            const double period = e.p[3], delay = e.p[5], on = e.p[4] * period;
            double k0 = std::max(0.0, std::floor((after - delay) / period));
            for (int k = 0; k < 2; ++k) {
                const double base = delay + (k0 + k) * period;
                consider(base);
                consider(base + on);
            }
        }
    }
    return best;
}

double CircuitSim::_lteRatio(double h) const {
    if (!(_hPrev > 0.0)) return 0.0;
    double worst = 0.0;
    const double r = h / (2.0 * _hPrev);
    for (const Element& e : _el) {
        if (e.kind != Kind::C && e.kind != Kind::L) continue;
        double qNew;
        if (e.kind == Kind::C) {
            qNew = e.p[0] * (_nodeV(_xTry, e.t[0]) - _nodeV(_xTry, e.t[1]));
        } else {
            qNew = e.p[0] * _xTry[e.branch];
            for (int ki : _coupling) {
                const Element& k = _el[ki];
                const int a = static_cast<int>(k.p[0]), b = static_cast<int>(k.p[1]);
                const Element* self = &e;
                const Element* other = nullptr;
                if (&_el[a] == self) other = &_el[b];
                else if (&_el[b] == self) other = &_el[a];
                if (other) qNew += k.p[2] * std::sqrt(_el[a].p[0] * _el[b].p[0]) * _xTry[other->branch];
            }
        }
        const double qPred = e.q + h * (e.dq + r * (e.dq - e.dqPrev));
        const double err = std::abs(qNew - qPred) / 6.0;
        const double absTol = e.p[0] * (e.kind == Kind::C ? _opt.vntol : 1e-6);
        const double tol = _opt.lteReltol * std::max(e.qPeak, std::abs(qNew)) + absTol;
        worst = std::max(worst, err / tol);
    }
    return worst;
}

void CircuitSim::_accept(double t1, double h, Method m) {
    (void)m;
    _x = _xTry;
    for (Element& e : _el) {
        const double pOld = e.v * e.i, iOld = e.i;
        const double va = _nodeV(_x, e.t[0]), vb = _nodeV(_x, e.t[1]);
        double v = va - vb, i = 0.0;
        switch (e.kind) {
            case Kind::R: i = v / e.p[0]; break;
            case Kind::C: i = e.gEq * v - e.iEq; break;
            case Kind::L: case Kind::V: case Kind::E: case Kind::AM: i = _x[e.branch]; break;
            case Kind::I: i = _sourceValue(e, t1); break;
            case Kind::G: i = e.p[0] * (_nodeV(_x, e.t[2]) - _nodeV(_x, e.t[3])); break;
            case Kind::D: {
                const int j = e.inner > 0 ? e.inner : e.t[0];
                const double vj = _nodeV(_x, j) - vb;
                i = e.gEq * vj + e.iEq;
                const double nvt = e.p[1] * DIODE_VT;
                const bool on = vj > 0.5 * nvt * std::log(nvt / (std::sqrt(2.0) * e.p[0]));
                if (on != e.on && !_first) _regionChanged = true;
                e.on = on;
                break;
            }
            case Kind::S: i = e.gEq * v; break;
            case Kind::M: {
                const int d = e.swapped ? e.t[2] : e.t[0];
                const int s = e.swapped ? e.t[0] : e.t[2];
                const double vds = _nodeV(_x, d) - _nodeV(_x, s);
                const double vgs = _nodeV(_x, e.t[1]) - _nodeV(_x, s);
                const double ids = e.gEq * vds + e.gM * vgs + e.iEq; // d' → s'
                v = _nodeV(_x, e.t[0]) - _nodeV(_x, e.t[2]);
                i = e.swapped ? -ids : ids;
                const bool on = e.p[0] * vgs > e.p[1];
                if (on != e.on && !_first) _regionChanged = true;
                e.on = on;
                break;
            }
            case Kind::K: v = 0.0; i = 0.0; break;
            case Kind::VM: i = 0.0; break;
        }
        e.v = v;
        e.i = i;
        const double pNew = v * i;
        const double dE = 0.5 * h * (pOld + pNew);
        e.wE += dE;
        e.wQ += 0.5 * h * (iOld + i);
        e.wI2 += 0.5 * h * (iOld * iOld + i * i);
        if (isActive(e.kind)) _wSource -= dE;
        else if (isDissipative(e.kind)) _wDiss += dE;
        if (e.kind == Kind::S) e.sw = _switchClosedAt(e, t1 - 0.5 * h);
    }
    // Reactive states: q = C·v, λ = L·i + Σ M·i_other (after every current is in).
    for (Element& e : _el) {
        if (e.kind == Kind::C) { e.dqPrev = e.dq; e.dq = e.i; }
        else if (e.kind == Kind::L) { e.dqPrev = e.dq; e.dq = e.v; }
    }
    _syncCharges();
    for (Element& e : _el) {
        if (e.kind == Kind::C || e.kind == Kind::L) e.qPeak = std::max(e.qPeak, std::abs(e.q));
    }
    _t = t1;
    _hPrev = h;
    _first = false;
    _stat[ST_STEPS] += 1;
    if (m == Method::BE) _stat[ST_BE_STEPS] += 1;
    _stat[ST_MIN_STEP] = _stat[ST_MIN_STEP] > 0.0 ? std::min(_stat[ST_MIN_STEP], h) : h;
    _stat[ST_MAX_STEP] = std::max(_stat[ST_MAX_STEP], h);
}

int CircuitSim::step(double hHost) {
    if (!_loaded) return ERR_NOT_LOADED;
    for (Element& e : _el) { e.wE = 0.0; e.wQ = 0.0; e.wI2 = 0.0; }
    _wSource = 0.0;
    _wDiss = 0.0;
    _wSteps = 0;
    _wNewton = 0;
    _wRejected = 0;
    _storedStart = storedEnergy();
    if (!(hHost > 0.0) || !std::isfinite(hHost)) {
        _writeReadout(OK);
        return 0;
    }

    const double tEnd = _t + hHost;
    std::vector<double> vjSave(_el.size()), vj2Save(_el.size());
    int status = OK;
    int lteSkip = _beSteps > 0 ? 1 : 0;
    while (tEnd - _t > timeEps(tEnd)) {
        const double bp = _nextBreakpoint(_t);
        const double target = std::min(tEnd, bp);
        const double span = target - _t;
        double hWant = std::min(_hNext > 0.0 ? _hNext : _opt.maxStep, _opt.maxStep);
        const Method m = _beSteps > 0 ? Method::BE : Method::TR;
        if (m == Method::BE) hWant = std::min(hWant, std::max(_opt.minStep * 4.0, BE_START_FRACTION * std::min(_opt.maxStep, span)));
        const double nSteps = std::max(1.0, std::ceil(span / hWant - 1e-9));
        const double h = span / nSteps;

        for (std::size_t k = 0; k < _el.size(); ++k) { vjSave[k] = _el[k].vj; vj2Save[k] = _el[k].vj2; }
        int iters = 0;
        int r = _solvePoint(_t + h, h, m, iters);
        _wNewton += iters;
        _stat[ST_NEWTON] += iters;
        double ratio = 0.0;
        if (r == OK && m == Method::TR && lteSkip == 0) {
            ratio = _lteRatio(h);
            if (ratio > 1.0) r = LTE_REJECT;
        }
        if (r != OK) {
            for (std::size_t k = 0; k < _el.size(); ++k) { _el[k].vj = vjSave[k]; _el[k].vj2 = vj2Save[k]; }
            _wRejected += 1;
            _stat[ST_REJECTED] += 1;
            if (r == ERR_SINGULAR) {
                status = ERR_SINGULAR;
                std::snprintf(_err, sizeof _err, "singular matrix at t=%.6g s (a loop of voltage sources / inductors, or a floating source?)", _t);
                break;
            }
            const double hNew = r == LTE_REJECT ? h * std::max(0.25, 0.9 * std::cbrt(1.0 / ratio)) : 0.5 * h;
            if (hNew < _opt.minStep) {
                status = r == LTE_REJECT ? ERR_STEP : ERR_NEWTON;
                std::snprintf(_err, sizeof _err, "%s at t=%.6g s (step below %.3g s)",
                              r == LTE_REJECT ? "time step too small" : "Newton did not converge", _t, _opt.minStep);
                break;
            }
            _hNext = hNew;
            continue;
        }
        _accept(_t + h, h, m);
        _wSteps += 1;
        if (m == Method::BE) {
            _beSteps -= 1;
            lteSkip = 1;
            _hNext = std::min(_opt.maxStep, h * BE_GROWTH);
        } else {
            if (lteSkip > 0) {
                lteSkip -= 1;
                _hNext = std::min(_opt.maxStep, h * BE_GROWTH);
            } else if (ratio < 0.1) {
                _hNext = std::min(_opt.maxStep, 2.0 * hWant);
            } else {
                _hNext = hWant;
            }
        }
        if ((std::isfinite(bp) && std::abs(_t - bp) <= timeEps(bp)) || _regionChanged) _scheduleRestart();
        _regionChanged = false;
    }
    _writeReadout(status);
    return status == OK ? _wSteps : status;
}

} // namespace circuit

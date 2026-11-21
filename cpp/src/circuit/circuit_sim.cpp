// =============================================================
// circuit/circuit_sim.cpp  –  netlist load, parameters, readout, errors
//
// The packed netlist (circuit.h) is validated element by element; anything
// malformed is refused with a message, never clamped into something else —
// the TS side (src/circuit/netlist.ts) already speaks SI and validates first,
// so a refusal here is a bug report, not user input.
// =============================================================

#include "circuit.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>

namespace circuit {

namespace {

bool isInt(float v) { return std::isfinite(v) && std::floor(v) == v; }

/// Defaults for params a record leaves out (it may stop early).
void defaults(Kind k, double* p) {
    switch (k) {
        case Kind::D: p[0] = 1e-14; p[1] = 1.0; p[2] = 0.0; break;
        case Kind::S: p[0] = 1e-3; p[1] = 1e9; p[2] = 0.0; p[3] = 0.0; p[4] = 0.5; p[5] = 0.0; break;
        case Kind::M: p[0] = 1.0; p[1] = 1.0; p[2] = 1e-3; p[3] = 0.0; break;
        case Kind::K: p[2] = 0.0; break;
        default: break;
    }
}

} // namespace

int CircuitSim::_fail(int code, const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(_err, sizeof _err, fmt, ap);
    va_end(ap);
    _loaded = false;
    _el.clear();
    _n = 0;
    return code;
}

/// One parameter's validity for its element (also used by setParam).
static const char* badParam(Kind k, int idx, double v) {
    if (!std::isfinite(v)) return "is not finite";
    switch (k) {
        case Kind::R: return v > 0.0 ? nullptr : "resistance must be > 0";
        case Kind::C: return idx == 0 && !(v > 0.0) ? "capacitance must be > 0" : nullptr;
        case Kind::L: return idx == 0 && !(v > 0.0) ? "inductance must be > 0" : nullptr;
        case Kind::V: case Kind::I:
            if (idx == 0 && !(v == 0.0 || v == 1.0 || v == 2.0)) return "waveform must be 0 (dc), 1 (sin) or 2 (pulse)";
            return nullptr;
        case Kind::K: return idx == 2 && !(std::abs(v) < 1.0) ? "coupling |k| must be < 1" : nullptr;
        case Kind::D:
            if (idx == 0 && !(v > 0.0)) return "saturation current must be > 0";
            if (idx == 1 && !(v > 0.0)) return "emission coefficient must be > 0";
            if (idx == 2 && !(v >= 0.0)) return "series resistance must be ≥ 0";
            return nullptr;
        case Kind::S:
            if ((idx == 0 || idx == 1) && !(v > 0.0)) return "on/off resistance must be > 0";
            if (idx == 3 && !(v >= 0.0)) return "period must be ≥ 0";
            if (idx == 4 && !(v >= 0.0 && v <= 1.0)) return "duty must be in [0, 1]";
            if (idx == 5 && !(v >= 0.0)) return "delay must be ≥ 0";
            return nullptr;
        case Kind::M:
            if (idx == 0 && !(v == 1.0 || v == -1.0)) return "polarity must be +1 (n) or −1 (p)";
            if (idx == 2 && !(v > 0.0)) return "kp must be > 0";
            if (idx == 3 && !(v >= 0.0)) return "lambda must be ≥ 0";
            return nullptr;
        case Kind::E: case Kind::G: case Kind::VM: case Kind::AM: return nullptr;
    }
    return nullptr;
}

int CircuitSim::_parse(const float* p, int count) {
    if (!p || count < 4) return _fail(ERR_FORMAT, "netlist shorter than its header");
    if (!isInt(p[0]) || static_cast<int>(p[0]) != FORMAT_VERSION) return _fail(ERR_FORMAT, "netlist format %g, solver speaks %d", static_cast<double>(p[0]), FORMAT_VERSION);
    if (!isInt(p[1]) || !isInt(p[2]) || !isInt(p[3])) return _fail(ERR_FORMAT, "header counts must be integers");
    const int nodes = static_cast<int>(p[1]), elems = static_cast<int>(p[2]), nOpt = static_cast<int>(p[3]);
    if (nodes < 1 || nodes > MAX_NODES) return _fail(ERR_LIMITS, "%d nodes (1 … %d)", nodes, MAX_NODES);
    if (elems < 0 || elems > MAX_ELEMENTS) return _fail(ERR_LIMITS, "%d elements (0 … %d)", elems, MAX_ELEMENTS);
    if (nOpt < 0 || nOpt > 32 || 4 + nOpt > count) return _fail(ERR_FORMAT, "bad option count %d", nOpt);

    _opt = Options{};
    double* opt[OPTION_COUNT] = { &_opt.maxStep, &_opt.minStep, &_opt.reltol, &_opt.vntol,
                                  &_opt.abstol, &_opt.gmin, &_opt.maxNewton, &_opt.lteReltol };
    for (int i = 0; i < nOpt && i < OPTION_COUNT; ++i) {
        const double v = p[4 + i];
        if (std::isfinite(v) && v > 0.0) *opt[i] = v;
    }
    _opt.minStep = std::min(_opt.minStep, _opt.maxStep * 1e-3);
    _nUser = nodes;
    _el.clear();
    _el.reserve(elems);

    int at = 4 + nOpt;
    for (int k = 0; k < elems; ++k) {
        if (at + 2 > count) return _fail(ERR_FORMAT, "element %d: truncated", k);
        if (!isInt(p[at]) || p[at] < 0 || p[at] >= KIND_COUNT) return _fail(ERR_FORMAT, "element %d: unknown kind %g", k, static_cast<double>(p[at]));
        Element e;
        e.kind = static_cast<Kind>(static_cast<int>(p[at]));
        const int nt = static_cast<int>(p[at + 1]);
        if (!isInt(p[at + 1]) || nt != kind_terminals(e.kind)) return _fail(ERR_FORMAT, "element %d (%s): %d terminals, expected %d", k, kind_name(static_cast<int>(e.kind)), nt, kind_terminals(e.kind));
        at += 2;
        if (at + nt + 1 > count) return _fail(ERR_FORMAT, "element %d: truncated terminals", k);
        e.nt = nt;
        for (int j = 0; j < nt; ++j) {
            const float t = p[at + j];
            if (!isInt(t) || t < 0 || t >= nodes) return _fail(ERR_NODE, "element %d (%s): terminal %d is node %g (0 … %d)", k, kind_name(static_cast<int>(e.kind)), j, static_cast<double>(t), nodes - 1);
            e.t[j] = static_cast<int>(t);
        }
        at += nt;
        const int np = static_cast<int>(p[at]);
        if (!isInt(p[at]) || np < 0 || np > MAX_PARAMS || at + 1 + np > count) return _fail(ERR_FORMAT, "element %d: bad parameter count", k);
        ++at;
        defaults(e.kind, e.p);
        const int need = (e.kind == Kind::V || e.kind == Kind::I) ? 2 : (e.kind == Kind::K ? 3 : std::min(1, kind_params(e.kind)));
        if (np < need) return _fail(ERR_PARAM, "element %d (%s): %d parameters, needs %d", k, kind_name(static_cast<int>(e.kind)), np, need);
        for (int j = 0; j < np && j < kind_params(e.kind); ++j) e.p[j] = p[at + j];
        at += np;
        for (int j = 0; j < kind_params(e.kind); ++j) {
            if (const char* why = badParam(e.kind, j, e.p[j])) return _fail(ERR_PARAM, "element %d (%s): parameter %d %s", k, kind_name(static_cast<int>(e.kind)), j, why);
        }
        _el.push_back(e);
    }
    if (at != count) return _fail(ERR_FORMAT, "%d trailing floats after the last element", count - at);

    _coupling.clear();
    for (int k = 0; k < elems; ++k) {
        const Element& e = _el[k];
        if (e.kind != Kind::K) continue;
        const double a = e.p[0], b = e.p[1];
        if (a != std::floor(a) || b != std::floor(b) || a < 0 || b < 0 || a >= elems || b >= elems || a == b) {
            return _fail(ERR_PARAM, "element %d (K): needs two different inductor indices", k);
        }
        if (_el[static_cast<int>(a)].kind != Kind::L || _el[static_cast<int>(b)].kind != Kind::L) {
            return _fail(ERR_PARAM, "element %d (K): couples elements %d and %d, which are not both inductors", k, static_cast<int>(a), static_cast<int>(b));
        }
        _coupling.push_back(k);
    }
    return OK;
}

void CircuitSim::_layout() {
    _nNodes = _nUser;
    _nNonlinear = 0;
    for (Element& e : _el) {
        e.inner = -1;
        if (e.kind == Kind::D && e.p[2] > 0.0) e.inner = _nNodes++;
        if (e.kind == Kind::D || e.kind == Kind::M) ++_nNonlinear;
    }
    _nBranch = 0;
    for (Element& e : _el) {
        e.branch = -1;
        if (e.kind == Kind::L || e.kind == Kind::V || e.kind == Kind::E || e.kind == Kind::AM) {
            e.branch = (_nNodes - 1) + _nBranch++;
        }
    }
    _n = (_nNodes - 1) + _nBranch;
}

int CircuitSim::load(const float* packed, int count) {
    _loaded = false;
    _err[0] = '\0';
    const int r = _parse(packed, count);
    if (r != OK) return r;
    _layout();
    _buildPattern();
    _lu.setup(_n, _pattern);
    _loaded = true;
    _resetState();
    return OK;
}

void CircuitSim::_resetState() {
    _t = 0.0;
    _x.assign(_n, 0.0);
    _xTry.assign(_n, 0.0);
    _mat.assign(static_cast<std::size_t>(_n) * _n, 0.0);
    _rhs.assign(_n, 0.0);
    _matFact.clear();
    _haveFactor = false;
    _regionChanged = false;
    for (Element& e : _el) {
        e.v = 0.0; e.i = 0.0; e.q = 0.0; e.dq = 0.0; e.dqPrev = 0.0; e.qPeak = 0.0;
        e.vj = 0.0; e.vj2 = 0.0; e.gEq = 0.0; e.iEq = 0.0; e.gM = 0.0; e.swapped = false; e.on = false;
        e.wE = 0.0; e.wQ = 0.0; e.wI2 = 0.0;
        if (e.kind == Kind::C) { e.v = e.p[1]; e.q = e.p[0] * e.p[1]; }
        if (e.kind == Kind::L) { e.i = e.p[1]; e.q = e.p[0] * e.p[1]; }
        if (e.kind == Kind::S) e.sw = _switchClosedAt(e, 0.0);
    }
    for (int ki : _coupling) {
        const Element& k = _el[ki];
        Element& a = _el[static_cast<int>(k.p[0])];
        Element& b = _el[static_cast<int>(k.p[1])];
        const double M = k.p[2] * std::sqrt(a.p[0] * b.p[0]);
        a.q += M * b.i;
        b.q += M * a.i;
    }
    for (Element& e : _el) e.qPeak = std::abs(e.q);
    _hPrev = 0.0;
    _hNext = 0.0;
    _beSteps = 1;
    _first = true;
    for (double& s : _stat) s = 0.0;
    _stat[ST_UNKNOWNS] = _n;
    _stat[ST_NONLINEAR] = _nNonlinear;
    _wSteps = _wNewton = _wRejected = 0;
    _wSource = _wDiss = 0.0;
    _storedStart = storedEnergy();
    _writeReadout(OK);
}

void CircuitSim::reset() {
    if (_loaded) _resetState();
}

bool CircuitSim::setParam(int elem, int index, double value) {
    if (!_loaded || elem < 0 || elem >= elemCount()) return false;
    Element& e = _el[elem];
    if (index < 0 || index >= kind_params(e.kind)) return false;
    if (badParam(e.kind, index, value)) return false;
    if (e.kind == Kind::D && index == 2 && ((value > 0.0) != (e.p[2] > 0.0))) return false; // topology
    if (e.kind == Kind::M && index == 0 && value != e.p[0]) return false;
    if (e.kind == Kind::K && index < 2) return false;
    if (e.p[index] == value) return true;
    e.p[index] = value;
    // Before the first step a new C, L or initial condition re-derives the
    // initial charge / flux (an experiment's `set` at t = 0 sweeps C with the
    // same initial voltage); later a change keeps the stored charge / flux.
    if (_first && (e.kind == Kind::C || e.kind == Kind::L || e.kind == Kind::K)) _resetState();
    if (e.kind == Kind::S && index >= 2) _scheduleRestart();
    return true;
}

double CircuitSim::getParam(int elem, int index) const {
    if (!_loaded || elem < 0 || elem >= elemCount()) return 0.0;
    const Element& e = _el[elem];
    return (index >= 0 && index < kind_params(e.kind)) ? e.p[index] : 0.0;
}

double CircuitSim::stat(int which) const {
    return (which >= 0 && which < ST_COUNT) ? _stat[which] : 0.0;
}

void CircuitSim::_writeReadout(int status) {
    const std::size_t size = RO_HEADER + static_cast<std::size_t>(_nUser) + _el.size() * READOUT_STRIDE;
    _ro.assign(size, 0.0);
    _ro[RO_TIME] = _t;
    _ro[RO_STATUS] = status;
    _ro[RO_STEPS] = _wSteps;
    _ro[RO_NEWTON] = _wNewton;
    _ro[RO_REJECTED] = _wRejected;
    _ro[RO_W_SOURCE] = _wSource;
    _ro[RO_W_DISSIPATED] = _wDiss;
    _ro[RO_STORED] = storedEnergy();
    _ro[RO_STORED_START] = _storedStart;
    for (int k = 1; k < _nUser; ++k) _ro[RO_HEADER + k] = _nodeV(_x, k);
    double* row = &_ro[RO_HEADER + _nUser];
    for (const Element& e : _el) {
        row[RE_I] = e.i;
        row[RE_V] = e.v;
        row[RE_P] = e.v * e.i;
        row[RE_WE] = e.wE;
        row[RE_WQ] = e.wQ;
        row[RE_WI2] = e.wI2;
        row += READOUT_STRIDE;
    }
}

uintptr_t CircuitSim::scratchPtr(int count) {
    _scratch.resize(static_cast<std::size_t>(std::max(1, count)));
    return reinterpret_cast<uintptr_t>(_scratch.data());
}

} // namespace circuit

const char* circuit_kind_name(int kind) { return circuit::kind_name(kind); }
int circuit_format_version() { return circuit::FORMAT_VERSION; }

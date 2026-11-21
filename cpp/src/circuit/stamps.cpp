// =============================================================
// circuit/stamps.cpp  –  one MNA stamp per element + device models
//
// Unknowns: node voltages v1 … v(N−1) (ground is node 0 and has no row),
// then one branch current per L, V, E and AM. Every branch current flows
// from terminal a (p) to terminal b (n) *through* the element, so a source
// delivering power carries a negative current and absorbs negative power.
//
// Reactive elements are companion models in charge / flux form, so a port
// that changes C or L between steps conserves q or λ (ADR-0018):
//
//   C   TR  i₁ = (2/h)(C·v₁ − q₀) − i₀        BE  i₁ = (C·v₁ − q₀)/h
//   L   TR  v₁ = (2/h)(λ₁ − λ₀) − v₀          BE  v₁ = (λ₁ − λ₀)/h
//       λ = L·i + Σ M·i_other   (K couples two inductors, M = k·√(L_A·L_B))
// =============================================================

#include "circuit.h"

#include <algorithm>
#include <cmath>

namespace circuit {

namespace {

constexpr double PI = 3.14159265358979323846;
/// Thermal voltage kT/q at 300 K.
constexpr double VT = 0.025852;
/// Above this many n·Vt the diode exponential continues as its tangent line,
/// so a wild Newton iterate cannot overflow (pnjlim keeps real ones far below).
constexpr double EXP_LIMIT = 40.0;
/// Conductance across every junction (diode, MOSFET channel), at least the
/// node gmin. A bridge's floating source or secondary with all four diodes
/// off hangs on its junctions alone; at 1e-12 S that common mode sits ~1e13
/// below its siemens-scale neighbours. newton.cpp's residual test (_balanced)
/// is what lets Newton accept it at all; 1e-9 S makes it better posed, so a
/// 60 Hz transformer → bridge settles in ~20 % fewer iterations. 10 nA at
/// 10 V reverse, booked as the device's own current; the node shunt stays
/// 1e-12 S, so a linear circuit's energy is untouched.
constexpr double GMIN_JUNCTION = 1e-9;

struct Stamp {
    std::vector<double>& A;
    std::vector<double>& b;
    int n;
    char* pat; // non-null: mark the structural pattern instead

    void at(int r, int c, double v) const {
        if (r < 0 || c < 0) return;
        const std::size_t k = static_cast<std::size_t>(r) * n + c;
        if (pat) pat[k] = 1;
        else A[k] += v;
    }
    /// Conductance g between nodes a and b.
    void g(int na, int nb, double gv) const {
        const int ra = na - 1, rb = nb - 1;
        at(ra, ra, gv); at(rb, rb, gv); at(ra, rb, -gv); at(rb, ra, -gv);
    }
    /// Current I flowing a → b through the element.
    void i(int na, int nb, double I) const {
        if (pat) return;
        if (na > 0) b[na - 1] -= I;
        if (nb > 0) b[nb - 1] += I;
    }
    /// Branch row k for an element between a and b: KCL columns + KVL row.
    void branch(int na, int nb, int k) const {
        at(na - 1, k, 1.0); at(nb - 1, k, -1.0);
        at(k, na - 1, 1.0); at(k, nb - 1, -1.0);
    }
    /// gm·(v_cp − v_cn) flowing p → n through the element.
    void vccs(int p, int nn, int cp, int cn, double gm) const {
        at(p - 1, cp - 1, gm); at(p - 1, cn - 1, -gm);
        at(nn - 1, cp - 1, -gm); at(nn - 1, cn - 1, gm);
    }
    void rhs(int r, double v) const {
        if (!pat && r >= 0) b[r] += v;
    }
};

struct DiodeEval { double id, gd; };

DiodeEval diodeEval(double v, double is, double nvt) {
    const double arg = v / nvt;
    if (arg > EXP_LIMIT) {
        const double e = std::exp(EXP_LIMIT);
        return { is * (e * (1.0 + (arg - EXP_LIMIT)) - 1.0), is * e / nvt };
    }
    if (arg < -EXP_LIMIT) return { -is, 0.0 };
    const double e = std::exp(arg);
    return { is * (e - 1.0), is * e / nvt };
}

struct MosEval { double id, gm, gds; };

/// Shichman–Hodges level 1 in the n-channel frame, v_ds ≥ 0.
MosEval mosEval(double vgs, double vds, double vt, double kp, double lambda) {
    const double vov = vgs - vt;
    if (vov <= 0.0) return { 0.0, 0.0, 0.0 };
    const double cl = 1.0 + lambda * vds;
    if (vds < vov) {
        const double core = vov * vds - 0.5 * vds * vds;
        return { kp * core * cl, kp * vds * cl, kp * (vov - vds) * cl + kp * core * lambda };
    }
    return { 0.5 * kp * vov * vov * cl, kp * vov * cl, 0.5 * kp * vov * vov * lambda };
}

} // namespace

const char* kind_name(int kind) {
    static const char* const NAMES[KIND_COUNT] = { "R", "C", "L", "V", "I", "K", "E", "G", "D", "S", "VM", "AM", "M" };
    return kind >= 0 && kind < KIND_COUNT ? NAMES[kind] : "";
}

int kind_terminals(Kind k) {
    switch (k) {
        case Kind::K: return 0;
        case Kind::E: case Kind::G: return 4;
        case Kind::M: return 3;
        default: return 2;
    }
}

int kind_params(Kind k) {
    switch (k) {
        case Kind::R: return 1;
        case Kind::C: case Kind::L: return 2;
        case Kind::V: case Kind::I: return MAX_PARAMS;
        case Kind::K: return 3;
        case Kind::E: case Kind::G: return 1;
        case Kind::D: return 3;
        case Kind::S: return 6;
        case Kind::VM: case Kind::AM: return 0;
        case Kind::M: return 4;
    }
    return 0;
}

double CircuitSim::_nodeV(const std::vector<double>& x, int node) const {
    return node > 0 ? x[node - 1] : 0.0;
}

double CircuitSim::_sourceValue(const Element& e, double t) const {
    const double* p = e.p;
    switch (static_cast<Wave>(static_cast<int>(p[0]))) {
        case Wave::Dc:
            return p[1];
        case Wave::Sin: {
            const double off = p[1], amp = p[2], f = p[3], ph = p[4] * PI / 180.0, td = p[5], theta = p[6];
            if (t <= td) return off + amp * std::sin(ph);
            const double tt = t - td;
            return off + amp * std::exp(-tt * theta) * std::sin(2.0 * PI * f * tt + ph);
        }
        case Wave::Pulse: {
            const double v1 = p[1], v2 = p[2], td = p[3], tr = p[4], tf = p[5], pw = p[6], per = p[7];
            if (t <= td) return v1;
            double tt = t - td;
            if (per > 0.0) {
                tt = std::fmod(tt, per);
                // A corner that lands exactly on a period boundary belongs to
                // the period that ends there (left limit), like t ≤ td above.
                if (tt == 0.0) tt = per;
            }
            if (tt <= tr) return tr > 0.0 ? v1 + (v2 - v1) * tt / tr : v2;
            if (tt <= tr + pw) return v2;
            if (tt <= tr + pw + tf) return tf > 0.0 ? v2 + (v1 - v2) * (tt - tr - pw) / tf : v1;
            return v1;
        }
    }
    return 0.0;
}

bool CircuitSim::_switchClosedAt(const Element& e, double t) const {
    const double period = e.p[3];
    if (!(period > 0.0)) return e.p[2] >= 0.5;
    const double delay = e.p[5];
    if (t < delay) return false;
    const double phase = std::fmod(t - delay, period);
    return phase < e.p[4] * period;
}

void CircuitSim::_buildPattern() {
    _pattern.assign(static_cast<std::size_t>(_n) * _n, 0);
    _mat.assign(static_cast<std::size_t>(_n) * _n, 0.0);
    _rhs.assign(_n, 0.0);
    // The same stamps in marking mode: every position any value can reach.
    Stamp s{ _mat, _rhs, _n, _pattern.data() };
    for (int k = 1; k < _nNodes; ++k) s.at(k - 1, k - 1, 1.0);
    for (const Element& e : _el) {
        const int a = e.t[0], b = e.t[1];
        switch (e.kind) {
            case Kind::R: case Kind::C: case Kind::S: s.g(a, b, 1.0); break;
            case Kind::L: s.branch(a, b, e.branch); s.at(e.branch, e.branch, 1.0); break;
            case Kind::V: case Kind::AM: s.branch(a, b, e.branch); break;
            case Kind::E:
                s.branch(a, b, e.branch);
                s.at(e.branch, e.t[2] - 1, 1.0); s.at(e.branch, e.t[3] - 1, 1.0);
                break;
            case Kind::G: s.vccs(a, b, e.t[2], e.t[3], 1.0); break;
            case Kind::D: {
                const int j = e.inner > 0 ? e.inner : a;
                if (e.inner > 0) s.g(a, j, 1.0);
                s.g(j, b, 1.0);
                break;
            }
            case Kind::M: {
                const int d = e.t[0], g = e.t[1], src = e.t[2];
                s.g(d, src, 1.0);
                s.vccs(d, src, g, src, 1.0);
                s.vccs(src, d, g, d, 1.0); // the swapped orientation
                break;
            }
            case Kind::K: {
                const Element& la = _el[static_cast<int>(e.p[0])];
                const Element& lb = _el[static_cast<int>(e.p[1])];
                s.at(la.branch, lb.branch, 1.0);
                s.at(lb.branch, la.branch, 1.0);
                break;
            }
            case Kind::I: case Kind::VM: break;
        }
    }
}

void CircuitSim::_evalElement(Element& e, const std::vector<double>& x, double t1, double h,
                              Method m, bool /*dc*/) const {
    const double va = _nodeV(x, e.t[0]);
    const double vb = _nodeV(x, e.t[1]);
    switch (e.kind) {
        case Kind::D: {
            const double nvt = e.p[1] * VT;
            const DiodeEval d = diodeEval(e.vj, e.p[0], nvt);
            e.gEq = d.gd + std::max(_opt.gmin, GMIN_JUNCTION);
            e.iEq = d.id - d.gd * e.vj;
            break;
        }
        case Kind::M: {
            const double pol = e.p[0] >= 0.0 ? 1.0 : -1.0;
            double vgs = e.vj, vds = e.vj2;
            e.swapped = vds < 0.0;
            if (e.swapped) { vgs = vgs - vds; vds = -vds; } // gate to the drain, which now acts as source
            const MosEval me = mosEval(vgs, vds, e.p[1], e.p[2], e.p[3]);
            e.gEq = me.gds + std::max(_opt.gmin, GMIN_JUNCTION);
            e.gM = me.gm;
            e.iEq = pol * (me.id - me.gm * vgs - me.gds * vds);
            break;
        }
        case Kind::C: {
            const double C = e.p[0];
            if (m == Method::TR) { e.gEq = 2.0 * C / h; e.iEq = (2.0 / h) * e.q + e.i; }
            else                 { e.gEq = C / h;       e.iEq = e.q / h; }
            break;
        }
        case Kind::S:
            e.gEq = 1.0 / (_switchClosedAt(e, t1 - 0.5 * h) ? e.p[0] : e.p[1]);
            break;
        default:
            break;
    }
    (void)va; (void)vb;
}

void CircuitSim::_assemble(double t1, double h, Method m, bool dc) {
    std::fill(_mat.begin(), _mat.end(), 0.0);
    std::fill(_rhs.begin(), _rhs.end(), 0.0);
    Stamp s{ _mat, _rhs, _n, nullptr };
    for (int k = 1; k < _nNodes; ++k) s.at(k - 1, k - 1, _opt.gmin);
    const double c = m == Method::TR ? 2.0 / h : 1.0 / h;
    for (Element& e : _el) {
        _evalElement(e, _xTry, t1, h, m, dc);
        const int a = e.t[0], b = e.t[1];
        switch (e.kind) {
            case Kind::R: s.g(a, b, 1.0 / e.p[0]); break;
            case Kind::C:
                s.g(a, b, e.gEq);
                s.i(a, b, -e.iEq);
                break;
            case Kind::L:
                s.branch(a, b, e.branch);
                s.at(e.branch, e.branch, -c * e.p[0]);
                s.rhs(e.branch, -c * e.q - (m == Method::TR ? e.v : 0.0));
                break;
            case Kind::V:
                s.branch(a, b, e.branch);
                s.rhs(e.branch, _sourceValue(e, t1));
                break;
            case Kind::AM:
                s.branch(a, b, e.branch);
                break;
            case Kind::I: s.i(a, b, _sourceValue(e, t1)); break;
            case Kind::E:
                s.branch(a, b, e.branch);
                s.at(e.branch, e.t[2] - 1, -e.p[0]);
                s.at(e.branch, e.t[3] - 1, e.p[0]);
                break;
            case Kind::G: s.vccs(a, b, e.t[2], e.t[3], e.p[0]); break;
            case Kind::D: {
                const int j = e.inner > 0 ? e.inner : a;
                if (e.inner > 0) s.g(a, j, 1.0 / e.p[2]);
                s.g(j, b, e.gEq);
                s.i(j, b, e.iEq);
                break;
            }
            case Kind::S: s.g(a, b, e.gEq); break;
            case Kind::M: {
                const int d = e.swapped ? e.t[2] : e.t[0];
                const int src = e.swapped ? e.t[0] : e.t[2];
                const int g = e.t[1];
                s.g(d, src, e.gEq);
                s.vccs(d, src, g, src, e.gM);
                s.i(d, src, e.iEq);
                break;
            }
            case Kind::K: {
                const Element& la = _el[static_cast<int>(e.p[0])];
                const Element& lb = _el[static_cast<int>(e.p[1])];
                const double M = e.p[2] * std::sqrt(la.p[0] * lb.p[0]);
                s.at(la.branch, lb.branch, -c * M);
                s.at(lb.branch, la.branch, -c * M);
                break;
            }
            case Kind::VM: break;
        }
    }
}

double CircuitSim::nodeVoltage(int node) const {
    if (!_loaded || node < 0 || node >= _nNodes) return 0.0;
    return _nodeV(_x, node);
}

double CircuitSim::elemCurrent(int e) const {
    return (_loaded && e >= 0 && e < elemCount()) ? _el[e].i : 0.0;
}

double CircuitSim::elemVoltage(int e) const {
    return (_loaded && e >= 0 && e < elemCount()) ? _el[e].v : 0.0;
}

double CircuitSim::elemPower(int e) const {
    return (_loaded && e >= 0 && e < elemCount()) ? _el[e].v * _el[e].i : 0.0;
}

double CircuitSim::storedEnergy() const {
    if (!_loaded) return 0.0;
    double w = 0.0;
    for (const Element& e : _el) {
        if (e.kind == Kind::C) w += 0.5 * e.p[0] * e.v * e.v;
        else if (e.kind == Kind::L) w += 0.5 * e.p[0] * e.i * e.i;
        else if (e.kind == Kind::K) {
            const Element& la = _el[static_cast<int>(e.p[0])];
            const Element& lb = _el[static_cast<int>(e.p[1])];
            w += e.p[2] * std::sqrt(la.p[0] * lb.p[0]) * la.i * lb.i;
        }
    }
    return w;
}

} // namespace circuit

// =============================================================
// circuit/newton.cpp  –  one time point: Newton–Raphson on the MNA system
//
//   assemble at the devices' (limited) junction voltages → factor → solve
//   → limit each junction's new voltage (SPICE pnjlim for diodes, a step
//   clamp for MOSFET v_gs / v_ds) → converged when the unknowns moved less
//   than reltol·|x| + vntol (node) / abstol (branch) and nothing was limited.
//
// A second test accepts an iterate whose KCL / branch residual is at the
// round-off of its own terms (_balanced) — see there for the floating node
// that needs it.
//
// A linear circuit takes one solve. A factorisation is reused outright while
// the assembled matrix is bit-identical to the one it was computed from
// (a linear circuit at a fixed step: factor once, then only substitute);
// otherwise DenseLU refactors on the recorded pivot order (lu.h).
// Non-convergence is not an error here: transient.cpp halves the step.
// =============================================================

#include "circuit.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace circuit {

namespace {

constexpr double VT = 0.025852;
/// A row balances when its residual is this far below the sum of its terms
/// (a few ulps of a 10-term row).
constexpr double RESIDUAL_REL = 1e-13;
/// … and the residual test only applies once the update is this close to
/// Newton's own tolerance: it bounds what a balanced row can hide (a 1e-9 S
/// floating mode under a 300 A-scale row) to mV, while a µV round-off cycle
/// passes.
constexpr double NEAR_LOOSEN = 100.0;

/// SPICE3 pnjlim: keep a junction's Newton step on the exponential's scale.
double pnjlim(double vnew, double vold, double nvt, double vcrit, bool& limited) {
    if (vnew > vcrit && std::abs(vnew - vold) > 2.0 * nvt) {
        if (vold > 0.0) {
            const double arg = 1.0 + (vnew - vold) / nvt;
            vnew = arg > 0.0 ? vold + nvt * std::log(arg) : vcrit;
        } else {
            vnew = nvt * std::log(vnew / nvt);
        }
        limited = true;
    }
    return vnew;
}

double clampStep(double vnew, double vold, double maxDelta, bool& limited) {
    if (vnew - vold > maxDelta) { limited = true; return vold + maxDelta; }
    if (vold - vnew > maxDelta) { limited = true; return vold - maxDelta; }
    return vnew;
}

} // namespace

bool CircuitSim::_factorAndSolve() {
    const std::size_t nn = static_cast<std::size_t>(_n) * _n;
    const bool same = _haveFactor && _matFact.size() == nn
        && std::memcmp(_matFact.data(), _mat.data(), nn * sizeof(double)) == 0;
    if (same) {
        _stat[ST_REUSED] += 1;
    } else {
        _stat[ST_FACTORS] += 1;
        if (!_lu.factor(_mat.data())) {
            _haveFactor = false;
            _stat[ST_ANALYSES] = static_cast<double>(_lu.analyses());
            return false;
        }
        _matFact = _mat;
        _haveFactor = true;
        _stat[ST_ANALYSES] = static_cast<double>(_lu.analyses());
    }
    _lu.solve(_rhs.data());
    return true;
}

bool CircuitSim::_converged(double loosen) const {
    const int nv = _nNodes - 1;
    for (int r = 0; r < _n; ++r) {
        const double xn = _rhs[r], xo = _xTry[r];
        if (!std::isfinite(xn)) return false;
        const double tol = loosen * (_opt.reltol * std::max(std::abs(xn), std::abs(xo)) + (r < nv ? _opt.vntol : _opt.abstol));
        if (std::abs(xn - xo) > tol) return false;
    }
    return true;
}

/// The non-linear residual at the iterate the system was just assembled at:
/// with no junction limited, that linearisation is exact there, so
/// b − A·x is KCL (node rows, A) and the branch equations (V) at x itself.
/// Balanced when every row is within RESIDUAL_REL of the sum of its terms
/// plus abstol (node rows) / vntol (branch rows); used only once the last
/// update is within NEAR_LOOSEN × Newton's tolerance.
///
/// Why the update test alone is not enough: a bridge's floating source or
/// secondary with every diode off hangs on its junctions' gmin. A junction's
/// 1e-9 S shares a diagonal with its 1/rs (20 S) and survives only to an ulp
/// of 20 (3.6e-15 S); each iterate's 1e-17 change in g_d flips that ulp and
/// moves the floating mode by V·ulp / Σg ≈ 8 V · 3.6e-15 / 4e-9 ≈ 7 µV —
/// a 2-cycle no linear-solve accuracy removes, above vntol for ever. The
/// currents it moves are 1e-14 A: the circuit is solved, only an
/// ill-determined common-mode voltage jitters.
bool CircuitSim::_balanced() const {
    const int nv = _nNodes - 1;
    for (int r = 0; r < _n; ++r) {
        const double* row = &_mat[static_cast<std::size_t>(r) * _n];
        double res = _rhs[r], scale = std::abs(_rhs[r]);
        for (int j = 0; j < _n; ++j) {
            if (row[j] == 0.0) continue;
            const double t = row[j] * _xTry[j];
            res -= t;
            scale += std::abs(t);
        }
        if (!std::isfinite(res) || std::abs(res) > RESIDUAL_REL * scale + (r < nv ? _opt.abstol : _opt.vntol)) return false;
    }
    return true;
}

bool CircuitSim::_limitDevices() {
    bool limited = false;
    for (Element& e : _el) {
        if (e.kind == Kind::D) {
            const int j = e.inner > 0 ? e.inner : e.t[0];
            const double vnew = _nodeV(_xTry, j) - _nodeV(_xTry, e.t[1]);
            const double nvt = e.p[1] * VT;
            const double vcrit = nvt * std::log(nvt / (std::sqrt(2.0) * e.p[0]));
            e.vj = pnjlim(vnew, e.vj, nvt, vcrit, limited);
        } else if (e.kind == Kind::M) {
            const double pol = e.p[0] >= 0.0 ? 1.0 : -1.0;
            const double vd = _nodeV(_xTry, e.t[0]), vg = _nodeV(_xTry, e.t[1]), vs = _nodeV(_xTry, e.t[2]);
            e.vj = clampStep(pol * (vg - vs), e.vj, 1.0, limited);
            e.vj2 = clampStep(pol * (vd - vs), e.vj2, 4.0, limited);
        }
    }
    return limited;
}

int CircuitSim::_solvePoint(double t1, double h, Method m, int& iters) {
    _xTry = _x;
    const int maxIter = std::max(1, static_cast<int>(_opt.maxNewton));
    bool limited = true;  // the first assembly is at the predictor, not an iterate
    bool near = false;    // the last update was within NEAR_LOOSEN × the tolerance
    for (iters = 1; iters <= maxIter; ++iters) {
        _assemble(t1, h, m, false);
        if (_nNonlinear > 0 && near && !limited && _balanced()) return OK;
        if (!_factorAndSolve()) return ERR_SINGULAR;
        if (_nNonlinear == 0) {
            _xTry.swap(_rhs);
            for (double v : _xTry) if (!std::isfinite(v)) return ERR_NEWTON;
            return OK;
        }
        const bool conv = _converged(1.0);
        near = iters > 1 && _converged(NEAR_LOOSEN);
        _xTry.swap(_rhs);
        limited = _limitDevices();
        if (conv && !limited && iters > 1) return OK;
    }
    return ERR_NEWTON;
}

} // namespace circuit

// =============================================================
// circuit/lu.cpp  –  dense LU: analyse / refactor / solve (see lu.h)
// =============================================================

#include "lu.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace circuit {

namespace {
/// Only an exactly-zero (or denormal) pivot is singular, as in SPICE's
/// Sparse (AbsThreshold 0): a node held to ground by nothing but gmin is a
/// legitimate 1e-12 S pivot next to a 1e9 S companion conductance, so a
/// threshold relative to the matrix scale would refuse a floating bridge
/// source. Topological singularities (a loop of voltage sources) are
/// refused before they get here, by the netlist compiler (src/circuit/netlist.ts).
constexpr double SINGULAR_ABS = 1e-300;
} // namespace

void DenseLU::setup(int n, const std::vector<char>& pattern) {
    _n = n;
    _lu.assign(static_cast<std::size_t>(n) * n, 0.0);
    _perm.resize(n);
    _pat = pattern;
    _y.assign(n, 0.0);
    _haveSymbolic = false;
}

bool DenseLU::factor(const double* A) {
    if (_n == 0) return true;
    if (_haveSymbolic && _refactor(A)) {
        ++_refactors;
        return true;
    }
    ++_analyses;
    return _analyse(A);
}

bool DenseLU::_analyse(const double* A) {
    const int n = _n;
    std::copy(A, A + static_cast<std::size_t>(n) * n, _lu.begin());
    for (int i = 0; i < n; ++i) _perm[i] = i;
    const double tiny = SINGULAR_ABS;
    for (int k = 0; k < n; ++k) {
        int r = k;
        double best = std::abs(_lu[static_cast<std::size_t>(k) * n + k]);
        for (int i = k + 1; i < n; ++i) {
            const double a = std::abs(_lu[static_cast<std::size_t>(i) * n + k]);
            if (a > best) { best = a; r = i; }
        }
        if (!(best > tiny)) {
            _haveSymbolic = false;
            return false;
        }
        if (r != k) {
            std::swap_ranges(_lu.begin() + static_cast<std::ptrdiff_t>(k) * n,
                             _lu.begin() + static_cast<std::ptrdiff_t>(k + 1) * n,
                             _lu.begin() + static_cast<std::ptrdiff_t>(r) * n);
            std::swap(_perm[k], _perm[r]);
        }
        const double piv = _lu[static_cast<std::size_t>(k) * n + k];
        double* rowK = &_lu[static_cast<std::size_t>(k) * n];
        for (int i = k + 1; i < n; ++i) {
            double* rowI = &_lu[static_cast<std::size_t>(i) * n];
            if (rowI[k] == 0.0) continue;
            const double l = rowI[k] / piv;
            rowI[k] = l;
            for (int j = k + 1; j < n; ++j) rowI[j] -= l * rowK[j];
        }
    }
    _symbolic();
    return true;
}

void DenseLU::_symbolic() {
    const int n = _n;
    // Pattern in pivot order, then symbolic elimination for the fill.
    std::vector<char> s(static_cast<std::size_t>(n) * n, 0);
    for (int k = 0; k < n; ++k) {
        const char* src = &_pat[static_cast<std::size_t>(_perm[k]) * n];
        std::copy(src, src + n, s.begin() + static_cast<std::ptrdiff_t>(k) * n);
        s[static_cast<std::size_t>(k) * n + k] = 1; // the pivot is always touched
    }
    for (int k = 0; k < n; ++k) {
        const char* rowK = &s[static_cast<std::size_t>(k) * n];
        for (int i = k + 1; i < n; ++i) {
            char* rowI = &s[static_cast<std::size_t>(i) * n];
            if (!rowI[k]) continue;
            for (int j = k + 1; j < n; ++j) rowI[j] = static_cast<char>(rowI[j] | rowK[j]);
        }
    }
    _lPtr.assign(n + 1, 0);
    _uPtr.assign(n + 1, 0);
    _lIdx.clear();
    _uIdx.clear();
    for (int k = 0; k < n; ++k) {
        for (int i = k + 1; i < n; ++i) if (s[static_cast<std::size_t>(i) * n + k]) _lIdx.push_back(i);
        _lPtr[k + 1] = static_cast<int>(_lIdx.size());
        for (int j = k + 1; j < n; ++j) if (s[static_cast<std::size_t>(k) * n + j]) _uIdx.push_back(j);
        _uPtr[k + 1] = static_cast<int>(_uIdx.size());
    }
    _haveSymbolic = true;
}

bool DenseLU::_refactor(const double* A) {
    const int n = _n;
    for (int k = 0; k < n; ++k) {
        const double* src = A + static_cast<std::size_t>(_perm[k]) * n;
        std::copy(src, src + n, _lu.begin() + static_cast<std::ptrdiff_t>(k) * n);
    }
    const double tiny = SINGULAR_ABS;
    for (int k = 0; k < n; ++k) {
        const double* rowK = &_lu[static_cast<std::size_t>(k) * n];
        const double piv = rowK[k];
        double colMax = 0.0;
        for (int p = _lPtr[k]; p < _lPtr[k + 1]; ++p) {
            colMax = std::max(colMax, std::abs(_lu[static_cast<std::size_t>(_lIdx[p]) * n + k]));
        }
        if (!(std::abs(piv) > tiny) || std::abs(piv) < PIVOT_REL * colMax) return false;
        for (int p = _lPtr[k]; p < _lPtr[k + 1]; ++p) {
            double* rowI = &_lu[static_cast<std::size_t>(_lIdx[p]) * n];
            if (rowI[k] == 0.0) continue;
            const double l = rowI[k] / piv;
            rowI[k] = l;
            for (int q = _uPtr[k]; q < _uPtr[k + 1]; ++q) {
                const int j = _uIdx[q];
                rowI[j] -= l * rowK[j];
            }
        }
    }
    return true;
}

void DenseLU::solve(double* b) const {
    const int n = _n;
    for (int k = 0; k < n; ++k) _y[k] = b[_perm[k]];
    for (int k = 0; k < n; ++k) {
        const double yk = _y[k];
        if (yk == 0.0) continue;
        for (int p = _lPtr[k]; p < _lPtr[k + 1]; ++p) {
            const int i = _lIdx[p];
            _y[i] -= _lu[static_cast<std::size_t>(i) * n + k] * yk;
        }
    }
    for (int k = n - 1; k >= 0; --k) {
        const double* rowK = &_lu[static_cast<std::size_t>(k) * n];
        double s = _y[k];
        for (int q = _uPtr[k]; q < _uPtr[k + 1]; ++q) s -= rowK[_uIdx[q]] * _y[_uIdx[q]];
        _y[k] = s / rowK[k];
    }
    for (int k = 0; k < n; ++k) b[k] = _y[k];
}

} // namespace circuit

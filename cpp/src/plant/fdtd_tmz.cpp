// =============================================================
// fdtd_tmz.cpp  –  FdtdTmzGrid (see fdtd_tmz.h). Mirrors FdtdTmzGrid in
// src/physics/fdtd-tmz.ts term for term; `npm run test:fdtd` holds the TS,
// WASM and (transpiled) WGSL kernels to each other on an impulse.
// =============================================================

#include "fdtd_tmz.h"

#include <algorithm>
#include <cmath>

namespace {

/// fdtdLossAt: cubic sponge profile at a (half-)integer position, in double.
double lossAt(double px, double py, int n, int pml, double lossMax) {
    const double edge = n - 1;
    const double p = pml;
    const double d = std::max({ p - px, px - (edge - p), p - py, py - (edge - p), 0.0 });
    const double t = std::min(d / p, 1.0);
    return lossMax * t * t * t;
}

} // namespace

bool FdtdTmzGrid::init(int n, int pmlCells, float courant, float lossMax, float sourceRadius) {
    _n = 0;
    if (n < 8 || n > MAX_N || pmlCells < 1 || 2 * pmlCells >= n) return false;
    if (!std::isfinite(courant) || !std::isfinite(lossMax) || !std::isfinite(sourceRadius)) return false;
    if (!(courant > 0.f) || !(sourceRadius > 0.f) || lossMax < 0.f) return false;
    _n = n;
    _pml = pmlCells;
    _courant = courant;
    _lossMax = lossMax;
    _sourceRadius = sourceRadius;
    const std::size_t cells = static_cast<std::size_t>(n) * static_cast<std::size_t>(n);
    for (auto* v : { &_ez, &_hx, &_hy, &_lossE, &_lossHx, &_lossHy, &_j, &_nuX, &_nuY, &_lossEMat }) {
        v->assign(cells, 0.f);
    }
    const double lm = static_cast<double>(lossMax);
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            const std::size_t i = static_cast<std::size_t>(x + y * n);
            _lossE[i] = static_cast<float>(lossAt(x, y, n, pmlCells, lm));
            _lossHx[i] = static_cast<float>(lossAt(x, y + 0.5, n, pmlCells, lm));
            _lossHy[i] = static_cast<float>(lossAt(x + 0.5, y, n, pmlCells, lm));
        }
    }
    _hasMaterials = false;
    return true;
}

void FdtdTmzGrid::reset() {
    std::fill(_ez.begin(), _ez.end(), 0.f);
    std::fill(_hx.begin(), _hx.end(), 0.f);
    std::fill(_hy.begin(), _hy.end(), 0.f);
}

void FdtdTmzGrid::setSources(const float* packed, int count) {
    if (_n == 0) return;
    std::fill(_j.begin(), _j.end(), 0.f);
    if (!packed || count < 4) return;
    const int n = _n;
    const double r = _sourceRadius;
    const double inv2r2 = 1.0 / (2.0 * r * r);
    const int reach = static_cast<int>(std::ceil(r * 3.0));
    const int sources = std::min(count / 4, MAX_SOURCES);
    // J accumulates in float, one blob at a time — the TS Float32Array does.
    for (int k = 0; k < sources; ++k) {
        const double sx = packed[k * 4 + 0];
        const double sy = packed[k * 4 + 1];
        const double amp = std::isfinite(packed[k * 4 + 2]) ? packed[k * 4 + 2] : 0.0;
        if (!std::isfinite(sx) || !std::isfinite(sy)) continue;
        const int x0 = std::max(1, static_cast<int>(std::floor(sx)) - reach);
        const int x1 = std::min(n - 2, static_cast<int>(std::ceil(sx)) + reach);
        const int y0 = std::max(1, static_cast<int>(std::floor(sy)) - reach);
        const int y1 = std::min(n - 2, static_cast<int>(std::ceil(sy)) + reach);
        for (int y = y0; y <= y1; ++y) {
            for (int x = x0; x <= x1; ++x) {
                const double dx = x - sx, dy = y - sy;
                const double r2 = dx * dx + dy * dy;
                if (r2 < 9.0 * r * r) {
                    float& jv = _j[static_cast<std::size_t>(x + y * n)];
                    jv = static_cast<float>(static_cast<double>(jv) + amp * std::exp(-r2 * inv2r2));
                }
            }
        }
    }
}

void FdtdTmzGrid::setMaterials(const float* interleaved, int count) {
    _hasMaterials = false;
    const int n = _n;
    if (n == 0 || !interleaved || count != 2 * n * n) return;
    bool vacuum = true;
    for (int i = 0; i < count; i += 2) {
        if (interleaved[i] != 1.f || interleaved[i + 1] != 0.f) { vacuum = false; break; }
    }
    if (vacuum) return; // same as none: keep step() on the ADR-0010 path
    // ν averaged across the two Ez nodes each H component sits between. The
    // last row / column have no neighbour; the H loop never reaches them.
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            const int i = x + y * n;
            const float here = interleaved[2 * i];
            _nuX[i] = y + 1 < n ? 0.5f * (here + interleaved[2 * (i + n)]) : here;
            _nuY[i] = x + 1 < n ? 0.5f * (here + interleaved[2 * (i + 1)]) : here;
            _lossEMat[i] = _lossE[i] + interleaved[2 * i + 1];
        }
    }
    _hasMaterials = true;
}

template <bool kMaterials>
void FdtdTmzGrid::_stepOnce() {
    const int n = _n;
    const float S = _courant;
    float* __restrict ez = _ez.data();
    float* __restrict hx = _hx.data();
    float* __restrict hy = _hy.data();
    const float* __restrict lossHx = _lossHx.data();
    const float* __restrict lossHy = _lossHy.data();
    const float* __restrict nuXs = _nuX.data();
    const float* __restrict nuYs = _nuY.data();
    for (int y = 0; y < n - 1; ++y) {
        const int row = y * n;
        for (int x = 0; x < n - 1; ++x) {
            const int i = row + x;
            const float sx = lossHx[i];
            const float sy = lossHy[i];
            if constexpr (kMaterials) {
                hx[i] = ((1.f - sx) * hx[i] - S * nuXs[i] * (ez[i + n] - ez[i])) / (1.f + sx);
                hy[i] = ((1.f - sy) * hy[i] + S * nuYs[i] * (ez[i + 1] - ez[i])) / (1.f + sy);
            } else {
                hx[i] = ((1.f - sx) * hx[i] - S * (ez[i + n] - ez[i])) / (1.f + sx);
                hy[i] = ((1.f - sy) * hy[i] + S * (ez[i + 1] - ez[i])) / (1.f + sy);
            }
        }
    }
    const float* __restrict lossE = kMaterials ? _lossEMat.data() : _lossE.data();
    const float* __restrict j = _j.data();
    for (int y = 1; y < n - 1; ++y) {
        const int row = y * n;
        for (int x = 1; x < n - 1; ++x) {
            const int i = row + x;
            const float s = lossE[i];
            const float curl = (hy[i] - hy[i - 1]) - (hx[i] - hx[i - n]);
            ez[i] = ((1.f - s) * ez[i] + S * (curl - j[i])) / (1.f + s);
        }
    }
}

void FdtdTmzGrid::step(int steps) {
    if (_n == 0) return;
    for (int k = 0; k < steps; ++k) {
        if (_hasMaterials) _stepOnce<true>();
        else _stepOnce<false>();
    }
}

double FdtdTmzGrid::interiorEnergy() const {
    double e = 0;
    for (int y = _pml; y < _n - _pml; ++y) {
        for (int x = _pml; x < _n - _pml; ++x) {
            const std::size_t i = static_cast<std::size_t>(x + y * _n);
            e += static_cast<double>(_ez[i]) * _ez[i] + static_cast<double>(_hx[i]) * _hx[i]
               + static_cast<double>(_hy[i]) * _hy[i];
        }
    }
    return e;
}

uintptr_t FdtdTmzGrid::scratchPtr(int count) {
    const std::size_t n = count > 0 ? static_cast<std::size_t>(count) : 1;
    if (_scratch.size() < n) _scratch.resize(n);
    return reinterpret_cast<uintptr_t>(_scratch.data());
}

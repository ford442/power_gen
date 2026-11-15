#pragma once
// =============================================================
// fdtd_tmz.h  –  2D TM_z Yee FDTD slice, CPU kernel in C++ (#254 §5).
//
// The same update, material model and indexing (x + y·n) as FdtdTmzGrid in
// src/physics/fdtd-tmz.ts (the reference) and fdtd-tmz-compute.wgsl (the
// GPU slice, ADR-0010 / ADR-0012):
//
//   Hx ← ((1 − sx)·Hx − S·ν_x·(Ez[x, y+1] − Ez[x, y])) / (1 + sx)
//   Hy ← ((1 − sy)·Hy + S·ν_y·(Ez[x+1, y] − Ez[x, y])) / (1 + sy)
//   Ez ← ((1 − s)·Ez + S·(curl H − J)) / (1 + s)
//
// SoA: every field and coefficient is its own contiguous float array, so the
// inner x loop is a straight run of loads, multiplies and one divide that
// clang vectorises under -msimd128 (see cpp/README.md → flag study). The
// sponge profile and the Gaussian sources are rasterised in double and
// stored as float, exactly as the TS reference does, so the three kernels
// differ only in the update's arithmetic width.
//
// Normalized units (ε = μ₀ = c = Δx = 1), a classroom "see the wave" slice:
// no 3D, no FEM, and μ_r / σ are display values (see FDTD_MATERIAL_PRESETS).
// =============================================================

#include <cstdint>
#include <vector>

class FdtdTmzGrid {
public:
    static constexpr int MAX_N = 1024;
    static constexpr int MAX_SOURCES = 16;

    FdtdTmzGrid() = default;

    /// (Re)build an n×n grid. False (and an empty grid) on n outside
    /// [8, MAX_N], a sponge that does not fit, or a non-finite parameter.
    bool init(int n, int pmlCells, float courant, float lossMax, float sourceRadius);
    int  size() const { return _n; }

    /// Zero every field (materials and sources stay).
    void reset();
    /// Soft J_z sources as `count` floats, 4 per source (x, y, amp, polarity —
    /// FdtdSource / the shader's vec4f). At most MAX_SOURCES are used.
    void setSources(const float* packed, int count);
    /// Interleaved (1/μ_r, electric half-step loss) per cell, 2·n² floats
    /// (buildFdtdMaterialMap). A map of pure vacuum, or count ≠ 2·n², clears
    /// the materials: step() is then exactly the ADR-0010 kernel.
    void setMaterials(const float* interleaved, int count);
    void clearMaterials() { _hasMaterials = false; }
    bool hasMaterials() const { return _hasMaterials; }

    /// `steps` Yee steps (H then E).
    void step(int steps);

    /// Σ(Ez² + Hx² + Hy²) over the interior (sponge excluded), in double.
    double interiorEnergy() const;

    /// Field arrays, n² floats each (zero-copy views over HEAPF32 in WASM).
    uintptr_t ezPtr() const { return reinterpret_cast<uintptr_t>(_ez.data()); }
    uintptr_t hxPtr() const { return reinterpret_cast<uintptr_t>(_hx.data()); }
    uintptr_t hyPtr() const { return reinterpret_cast<uintptr_t>(_hy.data()); }
    const float* ez() const { return _ez.data(); }
    const float* hx() const { return _hx.data(); }
    const float* hy() const { return _hy.data(); }

    /// C++-owned float scratch of ≥ count floats (the C ABI stages array
    /// arguments here). Re-read HEAPF32 after it: the resize may grow the heap.
    uintptr_t scratchPtr(int count);

private:
    template <bool kMaterials>
    void _stepOnce();

    int _n{0};
    int _pml{0};
    float _courant{0.5f};
    float _lossMax{0.f};
    float _sourceRadius{1.6f};
    bool _hasMaterials{false};

    std::vector<float> _ez, _hx, _hy;
    std::vector<float> _lossE, _lossHx, _lossHy, _j;
    // Materials, SoA: ν = 1/μ_r averaged onto each H component, σ loss on E.
    std::vector<float> _nuX, _nuY, _lossEMat;
    std::vector<float> _scratch;
};

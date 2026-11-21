#pragma once
// =============================================================
// circuit/lu.h  –  dense LU with partial pivoting and symbolic reuse
//
// MNA matrices in a classroom circuit are small (a few dozen unknowns) and
// very sparse, and their structure never changes after load: only values do
// (a new step size, a switch, a diode's linearisation). So the factorisation
// is split the way sparse solvers split it:
//
//   analyse   full partial pivoting on the values in hand; records the pivot
//             order and, from the structural pattern, the fill-in — per
//             column, which rows below the pivot can be non-zero; per row,
//             which columns right of it can be.
//   refactor  the same pivot order and the recorded index lists: no pivot
//             search, no row swaps, no work on structural zeros. Each pivot
//             must still pass a threshold test against its column
//             (|u_kk| ≥ PIVOT_REL · max |a_ik|); one that fails sends the
//             whole factorisation back through analyse.
//
// No sparse (Markowitz) path: the issue asks for one only when a measured
// circuit needs it, and none does at MAX_NODES (docs/CIRCUIT.md → Solver).
// =============================================================

#include <vector>

namespace circuit {

class DenseLU {
public:
    static constexpr double PIVOT_REL = 1e-3;

    /// n unknowns; `pattern` is n·n row-major, non-zero where any stamp can
    /// write. Drops any previous factorisation.
    void setup(int n, const std::vector<char>& pattern);

    /// Factor A (n·n row-major). Refactors with the recorded symbolic
    /// factorisation when it has one and every pivot passes; otherwise a full
    /// analysis. False when A is numerically singular.
    bool factor(const double* A);

    /// b ← A⁻¹·b, in place, with the last successful factorisation.
    void solve(double* b) const;

    int size() const { return _n; }
    long analyses() const { return _analyses; }
    long refactors() const { return _refactors; }

private:
    bool _analyse(const double* A);
    bool _refactor(const double* A);
    void _symbolic();

    int _n{0};
    std::vector<double> _lu;   // rows in pivot order, L below / U on and above the diagonal
    std::vector<int> _perm;    // _perm[k] = original row at pivot position k
    std::vector<char> _pat;    // structural pattern, original row order
    std::vector<int> _lPtr, _lIdx; // column k: rows i > k that can be non-zero in L
    std::vector<int> _uPtr, _uIdx; // row k: columns j > k that can be non-zero in U
    mutable std::vector<double> _y;
    bool _haveSymbolic{false};
    long _analyses{0};
    long _refactors{0};
};

} // namespace circuit

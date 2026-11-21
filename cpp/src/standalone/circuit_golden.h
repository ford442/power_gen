#pragma once
// =============================================================
// standalone/circuit_golden.h  –  netlist builder + waveform measures for
// `--mode circuit` (native only; the same netlists are replayed in WASM by
// scripts/tests/circuit.test.mjs from the `--json` dump).
// =============================================================

#ifdef SIM_CORE_STANDALONE

#include "circuit/circuit.h"

#include <cmath>
#include <initializer_list>
#include <vector>

namespace circuit_golden {

using circuit::Kind;

/// Value as the packed netlist carries it (f32), so analytic answers use the
/// exact numbers the solver sees.
inline double f32(double v) { return static_cast<double>(static_cast<float>(v)); }

class NetBuilder {
public:
    int nodes{1};
    int elems{0};
    std::vector<float> body;
    std::vector<float> options;

    int node() { return nodes++; }
    int add(Kind k, std::initializer_list<int> t, std::initializer_list<double> p) {
        body.push_back(static_cast<float>(static_cast<int>(k)));
        body.push_back(static_cast<float>(t.size()));
        for (int x : t) body.push_back(static_cast<float>(x));
        body.push_back(static_cast<float>(p.size()));
        for (double v : p) body.push_back(static_cast<float>(v));
        return elems++;
    }
    std::vector<float> pack() const {
        std::vector<float> out{ static_cast<float>(circuit::FORMAT_VERSION), static_cast<float>(nodes),
                                static_cast<float>(elems), static_cast<float>(options.size()) };
        out.insert(out.end(), options.begin(), options.end());
        out.insert(out.end(), body.begin(), body.end());
        return out;
    }
};

/// Rising zero crossings of y(t), linearly interpolated.
inline std::vector<double> risingCrossings(const std::vector<double>& t, const std::vector<double>& y, double tFrom = 0.0) {
    std::vector<double> out;
    for (std::size_t k = 1; k < y.size(); ++k) {
        if (t[k - 1] < tFrom) continue;
        if (y[k - 1] < 0.0 && y[k] >= 0.0) {
            const double f = -y[k - 1] / (y[k] - y[k - 1]);
            out.push_back(t[k - 1] + f * (t[k] - t[k - 1]));
        }
    }
    return out;
}

/// Positive local maxima of y, refined by a parabola through three samples:
/// (time, value) pairs.
inline std::vector<std::pair<double, double>> peaks(const std::vector<double>& t, const std::vector<double>& y) {
    std::vector<std::pair<double, double>> out;
    for (std::size_t k = 1; k + 1 < y.size(); ++k) {
        if (!(y[k] > 0.0 && y[k] >= y[k - 1] && y[k] > y[k + 1])) continue;
        const double a = y[k - 1], b = y[k], c = y[k + 1];
        const double den = a - 2.0 * b + c;
        const double d = den != 0.0 ? 0.5 * (a - c) / den : 0.0;
        const double h = t[k + 1] - t[k];
        out.emplace_back(t[k] + d * h, b - 0.25 * (a - c) * d);
    }
    return out;
}

inline double rms(const std::vector<double>& y, std::size_t from) {
    double s = 0.0;
    std::size_t n = 0;
    for (std::size_t k = from; k < y.size(); ++k) { s += y[k] * y[k]; ++n; }
    return n ? std::sqrt(s / static_cast<double>(n)) : 0.0;
}

} // namespace circuit_golden

#endif // SIM_CORE_STANDALONE

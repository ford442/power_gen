// =============================================================
// chores_fft.cpp  –  windowed magnitude spectrum for the analysis panel
// Free functions (not a SimMode). Mirrors src/gpu-chores/fft-js.ts.
//
// Own iterative radix-2 Cooley–Tukey (no KISS FFT / FFTW): real input is
// loaded into a complex buffer with im = 0, optionally Hann-windowed over the
// `count` real samples, zero-padded to the next power of two N, transformed,
// and reduced to the one-sided amplitude spectrum (N/2 + 1 bins) in dB:
//
//   mag[k] = c_k · |X[k]| / Σw      c_k = 1 for k = 0 and k = N/2, else 2
//   db[k]  = max(20·log10(mag[k]), floorDb)
//
// so a sine of amplitude A centred on bin k reads 20·log10(A) dB and a DC
// level c reads 20·log10(|c|) — "dB re 1 unit of the input column". Work is
// done in double; only the input and the dB output are float.
// =============================================================

#include "../sim_core.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace {
constexpr double kPi = 3.14159265358979323846;

std::vector<double> g_fftRe;
std::vector<double> g_fftIm;
// Twiddle table exp(-2πi·k/N), k < N/2, for the last N it was built for.
std::vector<double> g_twRe;
std::vector<double> g_twIm;
int g_twN = 0;

void buildTwiddles(int n) {
    if (g_twN == n) return;
    const int half = n / 2;
    g_twRe.assign(static_cast<size_t>(std::max(1, half)), 1.0);
    g_twIm.assign(static_cast<size_t>(std::max(1, half)), 0.0);
    for (int k = 0; k < half; ++k) {
        const double ang = -2.0 * kPi * static_cast<double>(k) / static_cast<double>(n);
        g_twRe[static_cast<size_t>(k)] = std::cos(ang);
        g_twIm[static_cast<size_t>(k)] = std::sin(ang);
    }
    g_twN = n;
}

/// In-place iterative radix-2 DIT FFT; n must be a power of two (≥ 1).
void fftRadix2(double* re, double* im, int n) {
    // Bit-reversal permutation.
    for (int i = 1, j = 0; i < n; ++i) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    buildTwiddles(n);
    // Butterflies: stage `len` uses every (n / len)-th twiddle.
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1;
        const int step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int k = 0; k < half; ++k) {
                const double wr = g_twRe[static_cast<size_t>(k * step)];
                const double wi = g_twIm[static_cast<size_t>(k * step)];
                const int a = i + k;
                const int b = a + half;
                const double tr = re[b] * wr - im[b] * wi;
                const double ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}
} // namespace

int chores_fft_size(int count) {
    if (count <= 0 || count > CHORES_FFT_MAX_N) return 0;
    int n = 1;
    while (n < count) n <<= 1;
    return n;
}

int chores_fft_db(const float* in, int count, bool hann, float floorDb, float* out) {
    const int n = chores_fft_size(count);
    if (!in || !out || n == 0) return 0;
    g_fftRe.assign(static_cast<size_t>(n), 0.0);
    g_fftIm.assign(static_cast<size_t>(n), 0.0);

    // Periodic Hann over the `count` real samples; the zero pad stays zero.
    double windowSum = 0.0;
    for (int i = 0; i < count; ++i) {
        const double w = hann
            ? 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(count))
            : 1.0;
        const float x = in[i];
        g_fftRe[static_cast<size_t>(i)] = std::isfinite(x) ? w * static_cast<double>(x) : 0.0;
        windowSum += w;
    }
    // A 1-sample Hann window is all zero; fall back to unit gain, not ÷0.
    if (windowSum <= 0.0) windowSum = 1.0;

    fftRadix2(g_fftRe.data(), g_fftIm.data(), n);

    const int bins = n / 2 + 1;
    const double floor = static_cast<double>(floorDb);
    for (int k = 0; k < bins; ++k) {
        const double re = g_fftRe[static_cast<size_t>(k)];
        const double im = g_fftIm[static_cast<size_t>(k)];
        const double edge = (k == 0 || 2 * k == n) ? 1.0 : 2.0;
        const double mag = edge * std::sqrt(re * re + im * im) / windowSum;
        const double db = mag > 0.0 ? 20.0 * std::log10(mag) : floor;
        out[k] = static_cast<float>(std::max(db, floor));
    }
    return bins;
}

int chores_fft_db_scratch(int count, bool hann, float floorDb) {
    // The scratch JS filled through chores_scratch_ptr(count): asking for the
    // same count never reallocates it, so the samples are still there. The
    // input is copied into the double work buffers before any bin is written,
    // so the bins can land over the head of the scratch (bins ≤ count).
    if (chores_fft_size(count) == 0) return 0;
    float* scratch = reinterpret_cast<float*>(chores_scratch_ptr(count));
    return chores_fft_db(scratch, count, hann, floorDb, scratch);
}

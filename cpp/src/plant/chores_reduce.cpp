// =============================================================
// chores_reduce.cpp  –  generic f32 reduce / map for HUD + export
// Free functions (not a SimMode). Mirrors src/gpu-chores/reduce-js.ts.
// =============================================================

#include "../sim_core.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

void chores_reduce_f32(const float* data, int count, float out[5]) {
    double sum = 0.0;
    double sumSq = 0.0;
    float mn = std::numeric_limits<float>::infinity();
    float mx = -std::numeric_limits<float>::infinity();
    int n = 0;
    if (!data || count <= 0) {
        out[0] = 0.f;
        out[1] = 0.f;
        out[2] = 0.f;
        out[3] = 0.f;
        out[4] = 0.f;
        return;
    }
    for (int i = 0; i < count; ++i) {
        const float x = data[i];
        if (!std::isfinite(x)) continue;
        sum += static_cast<double>(x);
        sumSq += static_cast<double>(x) * static_cast<double>(x);
        if (x < mn) mn = x;
        if (x > mx) mx = x;
        ++n;
    }
    if (n == 0) {
        out[0] = 0.f;
        out[1] = 0.f;
        out[2] = 0.f;
        out[3] = 0.f;
        out[4] = 0.f;
        return;
    }
    out[0] = static_cast<float>(sum);
    out[1] = mn;
    out[2] = mx;
    out[3] = static_cast<float>(sumSq);
    out[4] = static_cast<float>(n);
}

void chores_map_scale_f32(const float* in, float* out, int count, float scale, float bias) {
    if (!in || !out || count <= 0) return;
    for (int i = 0; i < count; ++i) {
        const float x = in[i];
        out[i] = std::isfinite(x) ? scale * x + bias : 0.f;
    }
}

std::vector<float> chores_reduce_f32_vec(const std::vector<float>& data) {
    float out[5] = {0, 0, 0, 0, 0};
    chores_reduce_f32(data.empty() ? nullptr : data.data(), static_cast<int>(data.size()), out);
    return { out[0], out[1], out[2], out[3], out[4] };
}

std::vector<float> chores_map_scale_f32_vec(const std::vector<float>& data, float scale, float bias) {
    std::vector<float> out(data.size(), 0.f);
    chores_map_scale_f32(data.empty() ? nullptr : data.data(),
                         out.empty() ? nullptr : out.data(),
                         static_cast<int>(data.size()), scale, bias);
    return out;
}

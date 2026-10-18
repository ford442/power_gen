// =============================================================
// energy_network.cpp  –  Lab energy bus (ADR-0004 Phase B): declarative
// edges + budget allocation (pure extraction, no logic changes vs
// sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

#include <cmath>
#include <vector>

using namespace plant_common;

void SEGSimulator::setNetworkEdges(const std::vector<float>& flatEdges) {
    _networkEdges.clear();
    if (flatEdges.size() % 5 != 0) return;
    const int n = static_cast<int>(flatEdges.size() / 5);
    _networkEdges.reserve(n);
    for (int i = 0; i < n; ++i) {
        const int o = i * 5;
        // float → int of NaN/±inf (or anything outside int) is UB; such an
        // edge could only ever be skipped as out-of-range below, so drop it.
        const float fromF = flatEdges[o + 0];
        const float toF   = flatEdges[o + 1];
        if (!std::isfinite(fromF) || !std::isfinite(toF)
            || std::fabs(fromF) > 1e6f || std::fabs(toF) > 1e6f) continue;
        EnergyNetworkEdgeSpec e;
        e.fromMode   = static_cast<int>(fromF);
        e.toMode     = static_cast<int>(toF);
        e.maxWatts   = std::max(0.f, flatEdges[o + 2]);
        e.efficiency = flatEdges[o + 3] > 0.f ? flatEdges[o + 3] : 1.f;
        e.latencyS   = std::max(0.f, flatEdges[o + 4]);
        _networkEdges.push_back(e);
    }
    _networkEdgeAllocatedW.assign(_networkEdges.size(), 0.f);
}

float SEGSimulator::getNetworkEdgeAllocatedW(int edgeIndex) const {
    if (edgeIndex < 0 || edgeIndex >= static_cast<int>(_networkEdgeAllocatedW.size())) return 0.f;
    return _networkEdgeAllocatedW[edgeIndex];
}

EnergyNetworkDevicePower SEGSimulator::getNetworkDevicePower(int mode) const {
    if (mode < 0 || mode >= ENERGY_NETWORK_MODE_COUNT) return {};
    return _networkDevicePower[mode];
}

uintptr_t SEGSimulator::getScratchPtr(int count) {
    const size_t n = static_cast<size_t>(std::max(1, count));
    if (_scratch.size() < n) _scratch.resize(n, 0.f);
    return reinterpret_cast<uintptr_t>(_scratch.data());
}

void SEGSimulator::updateEnergyNetwork(
    bool couplingEnabled,
    float segPowerW,
    float segEfficiencyPct,
    const std::vector<float>& energyLevels,
    const std::vector<int>& enabledFlags)
{
    const std::vector<float> flags(enabledFlags.begin(), enabledFlags.end());
    _updateEnergyNetwork(couplingEnabled, segPowerW, segEfficiencyPct,
                         energyLevels.data(), static_cast<int>(energyLevels.size()),
                         flags.data(), static_cast<int>(flags.size()));
}

void SEGSimulator::updateEnergyNetworkFromScratch(
    bool couplingEnabled,
    float segPowerW,
    float segEfficiencyPct,
    int modeCount)
{
    const int scratch = static_cast<int>(_scratch.size());
    const int n = std::max(0, std::min(modeCount, scratch / 2));
    _updateEnergyNetwork(couplingEnabled, segPowerW, segEfficiencyPct,
                         _scratch.data(), n, _scratch.data() + n, n);
}

void SEGSimulator::_updateEnergyNetwork(
    bool couplingEnabled,
    float segPowerW,
    float segEfficiencyPct,
    const float* energyLevels, int levelCount,
    const float* enabledFlags, int flagCount)
{
    _networkSummary.couplingEnabled = couplingEnabled;

    float powerOutByMode[ENERGY_NETWORK_MODE_COUNT]{};
    float energyByMode[ENERGY_NETWORK_MODE_COUNT]{};
    float labBudgetW = 0.f;

    for (int m = 0; m < ENERGY_NETWORK_MODE_COUNT; ++m) {
        const bool enabled = (m < flagCount) ? (enabledFlags[m] != 0.f) : false;
        const float level = (m < levelCount) ? energyLevels[m] : 0.f;
        const float energy = std::isfinite(level) ? clampf(level, 0.f, 1.f) : 0.f;
        energyByMode[m] = energy;

        float outW = 0.f;
        if (enabled) {
            if (m == SIM_MODE_SEG) {
                outW = std::max(0.f, segPowerW);
            } else {
                const float nominal = power_gen::EnergyNetworkNameplates::WATTS[m];
                outW = std::max(0.f, energy * nominal);
            }
            labBudgetW += outW;
        }
        powerOutByMode[m] = outW;
    }

    const int edgeCount = static_cast<int>(_networkEdges.size());
    if (_networkEdgeAllocatedW.size() != static_cast<size_t>(edgeCount)) {
        _networkEdgeAllocatedW.assign(edgeCount, 0.f);
    }

    std::vector<float> requestedBySource(ENERGY_NETWORK_MODE_COUNT, 0.f);
    for (int i = 0; i < edgeCount; ++i) {
        const auto& edge = _networkEdges[i];
        const int from = edge.fromMode;
        const int to   = edge.toMode;
        if (from < 0 || from >= ENERGY_NETWORK_MODE_COUNT
            || to < 0 || to >= ENERGY_NETWORK_MODE_COUNT) {
            _networkEdgeAllocatedW[i] = 0.f;
            continue;
        }
        const bool fromOn = (from < flagCount) ? (enabledFlags[from] != 0.f) : false;
        const bool toOn = (to < flagCount) ? (enabledFlags[to] != 0.f) : false;
        const bool enabled = fromOn && toOn;
        const float sourceEnergy = energyByMode[from];
        const float visual = 0.12f + sourceEnergy * 0.88f;
        const float requestedW = enabled ? visual * edge.maxWatts : 0.f;
        requestedBySource[from] += requestedW;
        _networkEdgeAllocatedW[i] = requestedW;
    }

    if (couplingEnabled) {
        for (int i = 0; i < edgeCount; ++i) {
            const auto& edge = _networkEdges[i];
            const int from = edge.fromMode;
            if (from < 0 || from >= ENERGY_NETWORK_MODE_COUNT) continue;
            const float sourcePower = powerOutByMode[from];
            const float totalRequested = requestedBySource[from];
            const float scale = totalRequested > 1e-6f
                ? std::min(1.f, sourcePower / totalRequested) : 0.f;
            _networkEdgeAllocatedW[i] *= scale;
            // Optional edge efficiency (losses) — applied after budget clamp
            if (edge.efficiency > 0.f && edge.efficiency < 1.f) {
                _networkEdgeAllocatedW[i] *= edge.efficiency;
            }
        }
    } else if (edgeCount > 0) {
        // Visual-only: keep requested watts for telemetry accounting
        for (int i = 0; i < edgeCount; ++i) {
            const auto& edge = _networkEdges[i];
            if (edge.efficiency > 0.f && edge.efficiency < 1.f) {
                _networkEdgeAllocatedW[i] *= edge.efficiency;
            }
        }
    }

    float powerInByMode[ENERGY_NETWORK_MODE_COUNT]{};
    float totalAllocatedW = 0.f;
    for (int i = 0; i < edgeCount; ++i) {
        const auto& edge = _networkEdges[i];
        const int to = edge.toMode;
        if (to < 0 || to >= ENERGY_NETWORK_MODE_COUNT) continue;
        const float watts = _networkEdgeAllocatedW[i];
        totalAllocatedW += watts;
        powerInByMode[to] += watts;
    }

    for (int m = 0; m < ENERGY_NETWORK_MODE_COUNT; ++m) {
        const float powerInW  = powerInByMode[m];
        const float powerOutW = powerOutByMode[m];
        float efficiency = 0.f;
        if (m == SIM_MODE_SEG && segEfficiencyPct > 0.f) {
            efficiency = segEfficiencyPct;
        } else if (powerInW > 1e-3f) {
            efficiency = std::min(100.f, (powerOutW / powerInW) * 100.f);
        }
        _networkDevicePower[m] = { powerInW, powerOutW, efficiency };
    }

    _networkSummary.labBudgetW       = labBudgetW;
    _networkSummary.totalAllocatedW  = totalAllocatedW;
    _networkSummary.residualW        = labBudgetW - totalAllocatedW;
}

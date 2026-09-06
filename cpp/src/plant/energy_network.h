#pragma once
// Lab energy bus (ADR-0004 Phase B) — declarative edges + budget.

#include "../../../generated/constants.h"

struct EnergyNetworkEdgeSpec {
    int   fromMode{0};
    int   toMode{0};
    float maxWatts{0.f};
    float efficiency{1.f};
    float latencyS{0.f};
};

struct EnergyNetworkDevicePower {
    float powerInW{0.f};
    float powerOutW{0.f};
    float efficiency{0.f};
};

struct EnergyNetworkSummary {
    bool  couplingEnabled{false};
    float labBudgetW{0.f};
    float totalAllocatedW{0.f};
    float residualW{0.f};
};

static constexpr int ENERGY_NETWORK_MODE_COUNT = power_gen::EnergyNetworkNameplates::MODE_COUNT;

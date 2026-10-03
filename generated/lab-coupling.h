// AUTO-GENERATED from physics/coupling.json — do not edit.
// Regenerate: npm run codegen:constants
#pragma once

namespace power_gen {

/** One lab energy pipe by device id; the consumer maps ids to SimModes. */
struct EnergyPipeCatalogRow {
    const char* from;
    const char* to;
    float maxWatts;
};

static constexpr EnergyPipeCatalogRow ENERGY_PIPE_CATALOG[] = {
    { "seg", "heron", 1500.0f },
    { "heron", "kelvin", 800.0f },
    { "kelvin", "seg", 600.0f },
    { "kelvin", "peltier", 400.0f },
    { "peltier", "solar", 500.0f },
    { "seg", "mhd", 1200.0f },
    { "mhd", "peltier", 700.0f },
    { "solar", "maglev", 450.0f },
    { "maglev", "seg", 550.0f },
    { "solar", "transformer", 350.0f },
    { "transformer", "halbach-viz", 300.0f },
    { "halbach-viz", "homopolar", 320.0f },
    { "homopolar", "seg", 400.0f },
    { "mhd", "lorentz-sled", 300.0f },
    { "transformer", "jumping-ring", 260.0f },
    { "homopolar", "hall", 30.0f },
    { "transformer", "vdg", 60.0f },
    { "seg", "pulse-coil", 3.6f },
};

static constexpr int ENERGY_PIPE_CATALOG_COUNT = 18;

} // namespace power_gen

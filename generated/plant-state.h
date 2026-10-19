// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
#pragma once

// Plant snapshot layout (#224 §2), from each device's `state` block.
// Every mode saves [_time, _drive, <its state.fields with a cpp path>…] as
// floats into the SEGSimulator scratch (getScratchPtr) — see
// SEGSimulator::plantSave / plantLoad and docs/SNAPSHOTS.md.

#include <cstdint>

static constexpr uint32_t PLANT_STATE_LAYOUT_HASH = 0x21801834u;
static constexpr const char* DEVICE_CATALOG_HASH = "81caf605beca";

static constexpr int PLANT_STATE_SIZES[] = {
    137, // SIM_MODE_SEG
    8, // SIM_MODE_HERON
    8, // SIM_MODE_KELVIN
    4, // SIM_MODE_SOLAR
    10, // SIM_MODE_PELTIER
    9, // SIM_MODE_MHD
    9, // SIM_MODE_MAGLEV
    9, // SIM_MODE_HOMOPOLAR
    11, // SIM_MODE_TRANSFORMER
    10, // SIM_MODE_VDG
    9, // SIM_MODE_HALL
    8, // SIM_MODE_LORENTZ_SLED
    10, // SIM_MODE_JUMPING_RING
};

static_assert(sizeof(PLANT_STATE_SIZES) / sizeof(PLANT_STATE_SIZES[0]) == 13,
              "PLANT_STATE_SIZES must cover every SimMode");

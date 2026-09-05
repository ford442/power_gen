// AUTO-GENERATED from physics/devices.json — do not edit.
// Regenerate: npm run codegen:catalog
#pragma once

enum SimMode {
    SIM_MODE_SEG = 0,
    SIM_MODE_HERON = 1,
    SIM_MODE_KELVIN = 2,
    SIM_MODE_SOLAR = 3,
    SIM_MODE_PELTIER = 4,
    SIM_MODE_MHD = 5,
    SIM_MODE_MAGLEV = 6,
    SIM_MODE_HOMOPOLAR = 7,
    SIM_MODE_TRANSFORMER = 8,
    SIM_MODE_VDG = 9,
    SIM_MODE_HALL = 10,
    SIM_MODE_LORENTZ_SLED = 11
};

static constexpr int SIM_MODE_COUNT = 12;

struct DeviceCatalogRow {
    const char* id;
    int shaderMode;
    int wasmMode; // -1 = JS-only (no SimMode plant)
};

static constexpr DeviceCatalogRow DEVICE_CATALOG[] = {
    { "seg", 0, 0 },
    { "heron", 1, 1 },
    { "kelvin", 2, 2 },
    { "solar", 3, 3 },
    { "peltier", 4, 4 },
    { "mhd", 5, 5 },
    { "maglev", 6, 6 },
    { "pulse-coil", 7, -1 },
    { "homopolar", 8, 7 },
    { "halbach-viz", 9, -1 },
    { "transformer", 10, 8 },
    { "vdg", 12, 9 },
    { "hall", 13, 10 },
    { "lorentz-sled", 14, 11 }
};

static constexpr int DEVICE_CATALOG_COUNT = 14;

static constexpr int RESERVED_WASM_MODES[] = { 0 };
static constexpr int RESERVED_WASM_MODE_COUNT = 0;

static_assert(SIM_MODE_COUNT == 12, "SIM_MODE_COUNT must match physics/devices.json wasm plants");

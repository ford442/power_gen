// =============================================================
// plant_state.cpp  –  plant snapshots: SEGSimulator::plantSave / plantLoad
//
// The bodies are generated from each device's `state` block in
// physics/devices.json (scripts/codegen-device-catalog.mjs), so the C++
// vector and the TS DEVICE_STATE_LAYOUT can never disagree about the order.
// `npm run test:snapshots` holds the layout to "restore is exact": save,
// load into a fresh simulator, step both — the vectors stay bit-identical.
// =============================================================

#include "../sim_core.h"

#include <cmath>

#include "../../../generated/plant-state-impl.h"

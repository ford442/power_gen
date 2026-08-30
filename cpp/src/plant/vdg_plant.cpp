// =============================================================
// vdg_plant.cpp – Van de Graaff belt-charge / sphere-capacitance /
// spark-gap plant. Mirrors devices/quanta/van-de-graaff.ts (VDG constants
// + stepVdgPhysics) — same charge/voltage/spark-gap shape as _stepKelvin.
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void SEGSimulator::_stepVdg(float dt) {
    VdgState& v = _vdg;
    const float d = clampf(v.drive, 0.f, 1.f);
    v.beltMps = d * v.beltMaxMps;
    const float beltCurrentA = d * v.beltMaxCurrentA;

    // dQ/dt = beltCurrent − leakage(V/R_leak); leakage is deliberately weak
    // (R_leak ~ 5e13 Ohm) so the sphere is spark-limited, not leakage-limited.
    const float voltageBefore = v.chargeC / v.capacitanceF;
    const float leakageA = voltageBefore / v.leakageROhm;
    v.chargeC = std::max(0.f, v.chargeC + (beltCurrentA - leakageA) * dt);

    v.voltage = v.chargeC / v.capacitanceF;
    if (v.sparkTimer > 0.f) {
        v.sparkTimer = std::max(0.f, v.sparkTimer - dt);
    } else if (v.voltage >= v.vBreak) {
        v.chargeC *= v.sparkDischargeFrac;
        v.voltage = v.chargeC / v.capacitanceF;
        v.sparkTimer = v.sparkDurS;
        v.sparkAccum += 1.f;
    }

    v.sparkWindowT += dt;
    if (v.sparkWindowT >= v.sparkWindowS) {
        v.sparkHz = v.sparkAccum / v.sparkWindowT;
        v.sparkAccum = 0.f;
        v.sparkWindowT = 0.f;
    }
}

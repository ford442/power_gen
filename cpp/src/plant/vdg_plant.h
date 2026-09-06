#pragma once
// Van de Graaff belt-charge / isolated-sphere / spark-gap ODE.
// Classroom numbers: physics/constants.json → generated/constants.h.
// Isolated-sphere C = 4*pi*eps0*r; V_break = Kelvin E_air * gapM.

#include "../../../generated/constants.h"

struct VdgState {
    float chargeC{0.f};              // sphere charge, C
    float voltage{0.f};              // sphere voltage, V (= chargeC / capacitanceF)
    float beltMps{0.f};              // belt surface speed, m/s
    float capacitanceF{
        4.f * PhysicsConstants::PI * PhysicsConstants::EPSILON_0
        * power_gen::VdgConstants::SPHERE_RADIUS_M};
    float vBreak{
        power_gen::KelvinConstants::E_BREAKDOWN_VM
        * power_gen::VdgConstants::GAP_M};
    float beltMaxMps{power_gen::VdgConstants::BELT_MAX_MPS};
    float beltMaxCurrentA{power_gen::VdgConstants::BELT_MAX_CURRENT_A};
    float leakageROhm{power_gen::VdgConstants::LEAKAGE_R_OHM};
    float sparkDischargeFrac{power_gen::VdgConstants::SPARK_DISCHARGE_FRAC};
    float sparkTimer{0.f};
    float sparkDurS{power_gen::VdgConstants::SPARK_DUR_S};
    float sparkAccum{0.f};           // sparks counted in the current rate window
    float sparkWindowT{0.f};
    float sparkWindowS{power_gen::VdgConstants::SPARK_RATE_WINDOW_S};
    float sparkHz{0.f};              // derived rolling spark rate
    float drive{0.f};
};

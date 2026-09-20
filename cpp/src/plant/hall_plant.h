#pragma once
// Hall-effect bench: I, B -> Hall voltage V_H = I*B/(n*e*t), R_H = 1/(n*e).
// Classroom numbers: physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"

struct HallState {
    float current{0.f};        // strip current, A
    float fieldT{0.f};         // applied field, T
    float voltage{0.f};        // derived Hall voltage, V
    float coeff{0.f};          // derived R_H = 1/(n*e), m^3/C
    float iMaxA{power_gen::HallConstants::I_MAX_A};
    float bMaxT{power_gen::HallConstants::B_MAX_T};
    float smoothingTau{power_gen::HallConstants::SMOOTHING_TAU};
    // Coupled B setpoint (T) from the lab FieldNetwork under ?fieldCoupling=1.
    // Negative = no coupling, i.e. B follows the shared drive control as before
    // (the default, and what the goldens exercise). See ADR-0011.
    float fieldCoupledT{-1.f};
    bool  carrierMetal{false}; // false = semiconductor, true = metal
    float drive{0.f};
};

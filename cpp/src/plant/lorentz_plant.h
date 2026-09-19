#pragma once
// Lorentz rail sled: series R-L drive loop closed through a sliding
// armature. L dI/dt = V - I R - B l v ; m dv/dt = I l B - friction.
// Mirrors LORENTZ in devices/quanta/lorentz-sled.ts. Educational
// Lorentz-force model — no projectile or ballistics state exists here.
// Classroom numbers: physics/constants.json → generated/constants.h.

#include "../../../generated/constants.h"

struct LorentzState {
    float currentA{0.f};    // armature / loop current, A
    float velocityMps{0.f}; // sled speed along the rails, m/s
    float positionM{0.f};   // position along the rails, m (wraps at railLengthM)
    float forceN{0.f};      // derived Lorentz force I*l*B, N
    float fieldT{power_gen::LorentzSledConstants::FIELD_T_DEFAULT};     // local bench field B, T (slider parameter)
    float fieldTMax{power_gen::LorentzSledConstants::FIELD_T_MAX};
    float railLengthM{power_gen::LorentzSledConstants::RAIL_LENGTH_M};
    float railGapM{power_gen::LorentzSledConstants::RAIL_GAP_M};   // l — rail separation the armature bridges
    float massKg{power_gen::LorentzSledConstants::SLED_MASS_KG};
    float supplyVMax{power_gen::LorentzSledConstants::SUPPLY_V_MAX};
    float rOhm{power_gen::LorentzSledConstants::CIRCUIT_R_OHM};
    float lHenry{power_gen::LorentzSledConstants::CIRCUIT_L_H};   // tau = L/R ~ 100 us -> analytic RL update
    float frictionMu{power_gen::LorentzSledConstants::FRICTION_MU};
    float viscousNsm{power_gen::LorentzSledConstants::VISCOUS_DAMPING_NSM};
    float vEpsMps{power_gen::LorentzSledConstants::V_EPS_MPS};    // tanh regularisation width for Coulomb friction
    float vMaxMps{power_gen::LorentzSledConstants::V_MAX_MPS};     // display normaliser (energyLevel)
    float drive{0.f};
};

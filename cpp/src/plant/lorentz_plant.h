#pragma once
// Lorentz rail sled: series R-L drive loop closed through a sliding
// armature. L dI/dt = V - I R - B l v ; m dv/dt = I l B - friction.
// Mirrors LORENTZ in devices/quanta/lorentz-sled.ts. Educational
// Lorentz-force model — no projectile or ballistics state exists here.

struct LorentzState {
    float currentA{0.f};    // armature / loop current, A
    float velocityMps{0.f}; // sled speed along the rails, m/s
    float positionM{0.f};   // position along the rails, m (wraps at railLengthM)
    float forceN{0.f};      // derived Lorentz force I*l*B, N
    float fieldT{0.8f};     // local bench field B, T (slider parameter)
    float fieldTMax{1.2f};
    float railLengthM{2.0f};
    float railGapM{0.25f};   // l — rail separation the armature bridges
    float massKg{0.15f};
    float supplyVMax{12.f};
    float rOhm{0.6f};
    float lHenry{6.0e-5f};   // tau = L/R ~ 100 us -> analytic RL update
    float frictionMu{0.25f};
    float viscousNsm{0.3f};
    float vEpsMps{0.05f};    // tanh regularisation width for Coulomb friction
    float vMaxMps{12.f};     // display normaliser (energyLevel)
    float drive{0.f};
};

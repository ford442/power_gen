#pragma once
// Kelvin water-dropper plant state — capacitive voltage + spark.

struct KelvinState {
    float voltage{0.f};       // V
    float vBreak{60000.f};    // V (E_BREAKDOWN * gap)
    float sparkTimer{0.f};
    float sparkDur{0.18f};
    float voltageN{0.f};      // 0..1
    float E{0.f};             // upward accel coeff
    float drive{0.f};
    // Seed potential (V) at the inductor rings from the lab ChargeNetwork under
    // ?chargeCoupling=1 (ADR-0013): a nearby charged VdG sphere biases the
    // induction the dropper amplifies. 0 = isolated bench, the default and what
    // the goldens exercise; V + 0 is exact, so the default path is unchanged.
    float seedV{0.f};
};

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
    // Share of the droplets' charge that reaches the collectors, 0..1. Near
    // breakdown a real dropper's streams splay and miss; the liquid picture
    // measures what lands and feeds it back here (docs/FLUIDS.md → Kelvin).
    // 1 = everything lands: the default, what the plant always assumed, and
    // what the goldens exercise — x * 1 is exact, so that path is unchanged.
    float collectEff{1.f};
};

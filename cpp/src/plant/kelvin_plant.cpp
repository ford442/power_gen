// =============================================================
// kelvin_plant.cpp  –  Kelvin water dropper plant (pure extraction, no
// logic changes vs sim_core.cpp)
// =============================================================

#include "../sim_core.h"
#include "plant_common.h"

using namespace plant_common;

void kelvin_particle_step(SimParticle& p, float kelvinE, float dt, float simTime) {
    // Drops in SI, held in scene units: gravity is divided by the bench's
    // metres per scene unit and the time by its display scale, so a drop falls
    // the 0.385 m from a drip tip to a collector's mouth in the 0.28 s it takes.
    // No drag, no separate scene gravity (this was g * 0.4 with a Stokes term),
    // and no field: the charged streams are the liquid picture's
    // (src/physics/kelvin-dropper.ts). The geometry is KELVIN_APPARATUS in
    // src/kelvin-layout.ts.
    (void)kelvinE;
    (void)simTime;
    constexpr float toScene = 1.f / power_gen::KelvinConstants::METRES_PER_SCENE_UNIT;
    constexpr float timeScale = power_gen::KelvinConstants::LIQUID_TIME_SCALE;
    constexpr float g = PhysicsConstants::G * toScene;
    constexpr float columnX = 2.5f, tipY = 5.87f, mouthY = -2.15f;
    const float h = dt * timeScale;
    p.vy -= g * h;
    p.x += p.vx * h; p.y += p.vy * h; p.z += p.vz * h;
    if (p.y < mouthY || p.y > tipY + 0.01f) {
        // Landed (or not yet released): leave the tip again, at the jet's speed.
        float side = (hash1(p.phase) > 0.5f) ? 1.f : -1.f;
        p.x = side * columnX;
        p.y = tipY;
        p.z = 0.f;
        p.vx = 0.f;
        p.vy = -power_gen::KelvinConstants::JET_SPEED_MAX_MS * toScene;
        p.vz = 0.f;
        p.aux = side;
    }
}

// Lab charge coupling (ADR-0013). v < 0 (or NaN) clears the seed and returns the
// bench to its isolated start; otherwise the seed is clamped to the bench's own
// breakdown voltage. Mirrors kelvinSeedV in renderers/shared/device-physics.ts.
void SEGSimulator::setKelvinSeedV(float seedV) {
    _kelvin.seedV = (seedV >= 0.f) ? clampf(seedV, 0.f, _kelvin.vBreak) : 0.f;
}

// What lands in the collectors, as a share of what the nozzles let go. A
// negative value (or NaN) means "not measured" and restores 1. Mirrors
// kelvinCollectionEff in renderers/shared/device-physics.ts.
void SEGSimulator::setKelvinCollectionEfficiency(float eff) {
    _kelvin.collectEff = (eff >= 0.f) ? clampf(eff, 0.f, 1.f) : 1.f;
}

void SEGSimulator::_stepKelvin(float dt) {
    KelvinState& k = _kelvin;
    constexpr float chargeRate = 8000.f, feedback = 2.f, leak = 0.3f;
    // The inductor sees its own terminal voltage plus any coupled seed; the
    // seed biases what the droplets carry, it is not a second charge source,
    // so with no water flowing (drive 0) it does nothing. Only the charge that
    // lands charges the collectors: the whole droplet current scales with
    // collectEff.
    k.voltage += (k.drive * k.collectEff * (chargeRate + feedback * (k.voltage + k.seedV)) - leak * k.voltage) * dt;
    k.voltage = std::max(0.f, k.voltage);
    if (k.voltage >= k.vBreak && k.sparkTimer <= 0.f) {
        k.voltage *= 0.02f;
        k.sparkTimer = k.sparkDur;
    }
    k.sparkTimer = std::max(0.f, k.sparkTimer - dt);
    k.voltageN = clampf(k.voltage / std::max(k.vBreak, 1.f), 0.f, 1.f);
    k.E = 15.f * k.voltageN;
}

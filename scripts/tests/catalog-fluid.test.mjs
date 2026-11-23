/**
 * The catalog's `fluid` blocks (physics/devices.json → scripts/lib/catalog-fluid.mjs
 * → generated/device-fluids.ts): validation, tier fall-back, and that the
 * scenes and gates are built from them.
 *
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FLUID_TIERS, emitFluidMatrix, resolveFluidTiers, validateFluid } from '../lib/catalog-fluid.mjs';
import { ROOT, bundleTs } from '../test-harness.mjs';

const catalog = JSON.parse(readFileSync(join(ROOT, 'physics', 'devices.json'), 'utf8'));
const M = await bundleTs({
  contents: `
    export * from './generated/device-fluids.ts';
    export { MPM_TIERS, mpmDerived } from './src/fluids/mpm-params.ts';
    export { heronLiquidScene, heronRiserM } from './src/fluids/heron-liquid.ts';
    export { kelvinLiquidScene, KELVIN_MAX_DROPS } from './src/fluids/kelvin-liquid.ts';
    export { HERON_LIQUID_OWNER } from './src/visualizer/heron-liquid-pass.ts';
    export { KELVIN_LIQUID_OWNER } from './src/visualizer/kelvin-liquid-pass.ts';
    export { getHeronLayout } from './src/heron-layout.ts';
  `,
  sourcefile: 'catalog-fluid-entry.ts'
});

const good = () => ({
  id: 'bench',
  fluid: {
    solver: 'mpm', what: 'a jet', draw: 'particles', fallback: 'droplets', model: 'weakly compressible',
    tiers: { low: { grid: 32, particles: 1000 }, high: { grid: 64, particles: 4000 } }
  }
});

describe('catalog fluid: validation', () => {
  it('the shipped catalog is clean, and a bench without a block is not an error', () => {
    assert.deepEqual(validateFluid(catalog.devices), []);
    assert.deepEqual(validateFluid([{ id: 'plain' }]), []);
    assert.deepEqual(validateFluid([good()]), []);
  });

  it('names what is wrong: solver, draw mode, a missing line of text, an unknown key', () => {
    const cases = [
      [(f) => { f.solver = 'sph'; }, /solver/],
      [(f) => { f.draw = 'mesh'; }, /draw/],
      [(f) => { delete f.model; }, /model/],
      [(f) => { f.fallback = ''; }, /fallback/],
      [(f) => { f.timeScale = 0.2; }, /unknown property "timeScale"/],
      [(f) => { f.tiers.ultra = { grid: 128, particles: 1 }; }, /unknown tier "ultra"/],
      [(f) => { delete f.tiers.low; }, /tiers\.low: required/],
      [(f) => { f.tiers.low.grid = 4; }, /grid/],
      [(f) => { f.tiers.low.grid = 300; }, /grid/],
      [(f) => { f.tiers.low.particles = 0; }, /particles/],
      [(f) => { f.tiers.low.particles = 1.5; }, /particles/],
      [(f) => { f.tiers.high = { grid: 16, particles: 4000 }; }, /smaller than the tier below/],
      [(f) => { f.tiers.low.cells = 3; }, /unknown property "cells"/]
    ];
    for (const [breakIt, want] of cases) {
      const d = good();
      breakIt(d.fluid);
      const errors = validateFluid([d]);
      assert.ok(errors.some((e) => want.test(e)), `${want}: got ${JSON.stringify(errors)}`);
      assert.ok(errors.every((e) => e.startsWith('bench.fluid')), 'every error says where');
    }
    assert.match(validateFluid([{ id: 'x', fluid: [] }])[0], /an object/);
  });

  it('a tier that is left out takes the next lower one', () => {
    assert.deepEqual(resolveFluidTiers(good().fluid), {
      low: { grid: 32, particles: 1000 }, default: { grid: 32, particles: 1000 }, high: { grid: 64, particles: 4000 }
    });
  });
});

describe('catalog fluid: the generated table is what the catalog says', () => {
  const withFluid = catalog.devices.filter((d) => d.fluid);

  it('lists exactly the benches with a block, with every tier filled in', () => {
    assert.deepEqual([...M.FLUID_DEVICE_IDS], withFluid.map((d) => d.id));
    for (const d of withFluid) {
      const f = M.DEVICE_FLUIDS[d.id];
      assert.deepEqual(f.tiers, resolveFluidTiers(d.fluid));
      for (const k of ['solver', 'what', 'draw', 'fallback', 'model']) assert.equal(f[k], d.fluid[k]);
    }
  });

  it('no bench asks a tier for more than the solver is sized for', () => {
    for (const id of M.FLUID_DEVICE_IDS) {
      for (const tier of FLUID_TIERS) {
        const want = M.DEVICE_FLUIDS[id].tiers[tier];
        const cap = M.MPM_TIERS[tier];
        assert.ok(want.grid <= cap.gridN, `${id}/${tier}: grid ${want.grid}³ over the solver's ${cap.gridN}³`);
        assert.ok(want.particles <= cap.particles, `${id}/${tier}: ${want.particles} particles over the solver's ${cap.particles}`);
      }
    }
  });

  it('every bench with a block is one a liquid pass owns', () => {
    assert.deepEqual([...M.FLUID_DEVICE_IDS].sort(), [M.HERON_LIQUID_OWNER, M.KELVIN_LIQUID_OWNER].sort());
  });

  it('MODE_MATRIX.md carries the section, a row per bench', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'MODE_MATRIX.md'), 'utf8');
    const section = emitFluidMatrix(catalog.devices);
    assert.ok(doc.includes(section), 'docs/MODE_MATRIX.md is stale: npm run codegen:catalog');
    for (const d of withFluid) assert.ok(section.includes(`| \`${d.id}\` |`));
    assert.match(section, /32³ \/ 2,048 at every tier/);
  });
});

describe('catalog fluid: the scenes are built from it', () => {
  it('Heron: each tier holds the catalog\'s particle slots inside its node budget', () => {
    for (const tier of FLUID_TIERS) {
      const budget = M.DEVICE_FLUIDS.heron.tiers[tier];
      const layout = M.getHeronLayout('classic');
      const scene = M.heronLiquidScene({ ...layout, riserM: M.heronRiserM(layout) }, tier);
      assert.equal(scene.config.maxParticles, budget.particles);
      assert.ok(M.mpmDerived(scene.config).nodes <= 1.1 * budget.grid ** 3);
    }
  });

  it('Kelvin: one size, whatever the tier', () => {
    const budget = M.DEVICE_FLUIDS.kelvin.tiers.low;
    assert.equal(M.KELVIN_MAX_DROPS, budget.particles);
    const sizes = FLUID_TIERS.map((tier) => M.kelvinLiquidScene(undefined, tier).config);
    for (const c of sizes) {
      assert.equal(c.maxParticles, budget.particles);
      assert.deepEqual(c.gridN, sizes[0].gridN);
      // The box is padded by wall nodes on every side, so allow them on top of the budget.
      assert.ok(M.mpmDerived(c).nodes <= 1.6 * budget.grid ** 3, `${c.gridN.join('×')} nodes on a budget of ${budget.grid}³`);
    }
  });
});

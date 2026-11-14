/**
 * device-mixins — bind the real DeviceInstance mixins the way the constructor
 * does and assert every helper `update()` reaches through `this.*` lands on the
 * instance.
 *
 * A stripped `updateDeviceFlowPaths` once crashed the first render. The old
 * version of this test regex-matched the sources and re-implemented
 * `bindMixinFunctions` locally, so it could pass while the shipped binder was
 * broken. This one bundles `src/device-instance.ts` and imports
 * `bindMixinFunctions` + `DEVICE_MIXINS` from it.
 *
 * Usage: npm run test:device-mixins   (node --test scripts/tests/device-mixins.test.mjs)
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

const mod = await bundleTs('src/device-instance.ts');
const { bindMixinFunctions, DEVICE_MIXINS } = mod;

describe('device-instance exports', () => {
  it('exports bindMixinFunctions', () => {
    assert.equal(typeof bindMixinFunctions, 'function');
  });
  it('exports DEVICE_MIXINS (3 mixins)', () => {
    assert.ok(Array.isArray(DEVICE_MIXINS) && DEVICE_MIXINS.length === 3, `DEVICE_MIXINS: ${DEVICE_MIXINS?.length}`);
  });
});

describe('bindMixinFunctions on the real DEVICE_MIXINS', () => {
  const target = {};
  before(() => {
    for (const mixin of DEVICE_MIXINS) bindMixinFunctions(target, mixin);
  });

  // Helpers `update()` and the render path reach only via `this.*`.
  for (const name of ['update', 'updateDeviceFlowPaths', 'updateEmitterEffects', '_computeEnergyLevel']) {
    it(`bound instance has ${name}()`, () => {
      assert.equal(typeof target[name], 'function');
    });
  }

  // Every function on every mixin is copied, and bound to the target.
  for (const [i, mixin] of (DEVICE_MIXINS ?? []).entries()) {
    it(`mixin[${i}]: every function is copied and bound`, () => {
      for (const [name, value] of Object.entries(mixin)) {
        if (typeof value !== 'function') continue;
        assert.ok(typeof target[name] === 'function' && target[name] !== value, `mixin[${i}].${name} copied`);
      }
    });
  }

  it('binds this to the target, not the mixin object', () => {
    const probe = { marker: 'target' };
    bindMixinFunctions(probe, { who() { return this.marker; } });
    assert.equal(probe.who(), 'target');
  });
});

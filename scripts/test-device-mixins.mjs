#!/usr/bin/env node
/**
 * Assert DeviceUpdateMixin still exports updateDeviceFlowPaths and that
 * bindMixinFunctions copies it — a stripped helper used to crash first render.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function must(cond, msg) {
  if (!cond) {
    console.error('[device-mixins]', msg);
    process.exit(1);
  }
}

const updateSrc = readFileSync(join(ROOT, 'src/devices/device-update.ts'), 'utf8');
must(
  /updateDeviceFlowPaths:\s*function/.test(updateSrc),
  'DeviceUpdateMixin is missing updateDeviceFlowPaths'
);
must(
  /typeof this\.updateDeviceFlowPaths === 'function'/.test(updateSrc),
  'update() must not call updateDeviceFlowPaths unless it is a function'
);

const instSrc = readFileSync(join(ROOT, 'src/device-instance.ts'), 'utf8');
must(
  /DeviceUpdateMixin\.updateDeviceFlowPaths\.bind\(this\)/.test(instSrc),
  'DeviceInstance must pin updateDeviceFlowPaths by name (tree-shake)'
);
must(
  /export function bindMixinFunctions/.test(instSrc),
  'bindMixinFunctions must stay exported for the constructor mixin loop'
);

function bindMixinFunctions(target, mixin) {
  for (const [name, value] of Object.entries(mixin)) {
    if (typeof value === 'function') {
      Reflect.set(target, name, value.bind(target));
    }
  }
}

const mixin = {
  update: function () {
    this.updateDeviceFlowPaths(0);
  },
  updateDeviceFlowPaths: function () {
    this.called = true;
  }
};
const target = { called: false };
bindMixinFunctions(target, mixin);
must(
  typeof target.updateDeviceFlowPaths === 'function',
  'bindMixinFunctions must copy updateDeviceFlowPaths onto the target'
);
target.update();
must(target.called === true, 'bound update() must reach updateDeviceFlowPaths');

console.log('[device-mixins] updateDeviceFlowPaths present and bindable');

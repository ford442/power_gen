#!/usr/bin/env node
/**
 * Bind the real DeviceInstance mixins the way the constructor does and assert
 * every helper `update()` reaches through `this.*` lands on the instance.
 *
 * A stripped `updateDeviceFlowPaths` once crashed the first render. The old
 * version of this test regex-matched the sources and re-implemented
 * `bindMixinFunctions` locally, so it could pass while the shipped binder was
 * broken. This one bundles `src/device-instance.ts` with esbuild and imports
 * `bindMixinFunctions` + `DEVICE_MIXINS` from it.
 *
 * Usage: node scripts/test-device-mixins.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

const result = await esbuild.build({
  entryPoints: [join(ROOT, 'src/device-instance.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  write: false,
  logLevel: 'silent',
  loader: { '.wgsl': 'text', '.glsl': 'text' },
  // `new URL('…', import.meta.url)` asset refs are evaluated at module load;
  // a data: URL is not a valid base, so give them a file: one.
  define: { 'import.meta.url': '"file:///stub/device-instance.js"' },
  plugins: [viteRawStub]
});
const mod = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);

const failures = [];
let checks = 0;
function check(label, cond) {
  checks++;
  if (!cond) failures.push(label);
}

const { bindMixinFunctions, DEVICE_MIXINS } = mod;
check('device-instance exports bindMixinFunctions', typeof bindMixinFunctions === 'function');
check('device-instance exports DEVICE_MIXINS (3 mixins)', Array.isArray(DEVICE_MIXINS) && DEVICE_MIXINS.length === 3);

if (failures.length === 0) {
  // Helpers `update()` and the render path reach only via `this.*`.
  const required = ['update', 'updateDeviceFlowPaths', 'updateEmitterEffects', '_computeEnergyLevel'];
  const target = {};
  for (const mixin of DEVICE_MIXINS) bindMixinFunctions(target, mixin);

  for (const name of required) {
    check(`bound instance has ${name}()`, typeof target[name] === 'function');
  }

  // Every function on every mixin is copied, and bound to the target.
  for (const [i, mixin] of DEVICE_MIXINS.entries()) {
    for (const [name, value] of Object.entries(mixin)) {
      if (typeof value !== 'function') continue;
      check(`mixin[${i}].${name} copied`, typeof target[name] === 'function' && target[name] !== value);
    }
  }

  // Bound `this` is the target, not the mixin object.
  const probe = { marker: 'target' };
  bindMixinFunctions(probe, { who() { return this.marker; } });
  check('bindMixinFunctions binds this to the target', probe.who() === 'target');
}

if (failures.length) {
  for (const f of failures) console.error('[device-mixins] FAIL', f);
  process.exit(1);
}
console.log(`[device-mixins] ${checks} checks OK — real DEVICE_MIXINS bind every helper`);

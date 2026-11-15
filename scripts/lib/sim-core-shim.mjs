/**
 * sim_core in Node harnesses (no fetch of file: URLs, no Vite).
 *
 *   simCoreShim(WASM_DIR)       esbuild plugin for harnesses that bundle the
 *                               app's loader (src/wasm/index.ts): its
 *                               `import('./sim-core/instantiate')` resolves to
 *                               a shim whose instantiateSimCore ignores the URL
 *                               and instantiates `<WASM_DIR>/sim_core.wasm`
 *                               from disk through the real instantiate.ts.
 *   loadSimCoreFromDisk(dir)    the same, called directly: the SimCoreModule
 *                               for a test that drives the ABI itself.
 *
 * Test-only: the production loader has no global or override seam.
 *
 *   plugins: [simCoreShim(WASM_DIR)]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleTs, ROOT } from '../test-harness.mjs';

const INSTANTIATE_TS = join(ROOT, 'src/wasm/sim-core/instantiate.ts');

export function simCoreShim(wasmDir) {
  const wasm = join(wasmDir, 'sim_core.wasm');
  const plugin = {
    name: 'sim-core-shim',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
      // Only the loader's relative import: the shim's own absolute import of
      // instantiate.ts below must resolve normally (or the shim imports itself).
      build.onResolve({ filter: /^\.\/sim-core\/instantiate(\.ts)?$/ }, () => ({ path: 'sim-core-shim', namespace: 'sim-core-shim' }));
      build.onLoad({ filter: /.*/, namespace: 'sim-core-shim' }, () => ({
        loader: 'js',
        resolveDir: ROOT,
        contents: `
          import { readFileSync } from 'node:fs';
          import { instantiateSimCore as real } from ${JSON.stringify(INSTANTIATE_TS)};
          export { SIM_CORE_IMPORTS } from ${JSON.stringify(INSTANTIATE_TS)};
          export function instantiateSimCore() {
            return real(readFileSync(${JSON.stringify(wasm)}));
          }
        `
      }));
    }
  };
  // test-harness.mjs cache key: the generated shim embeds these paths.
  plugin.cacheKey = wasmDir;
  return plugin;
}

let loader = null;

/**
 * The bundled loader: `instantiateSimCore`, plus the tables test:wasm-abi
 * diffs the binary against — `SIM_CORE_IMPORTS` (what the loader supplies)
 * and `SIM_CORE_ABI_EXPORTS` (what cpp/abi.json declares).
 */
export async function simCoreLoader() {
  loader ??= await bundleTs({
    contents: `export { instantiateSimCore, SIM_CORE_IMPORTS } from './src/wasm/sim-core/instantiate.ts';
export { SIM_CORE_ABI_EXPORTS } from './src/wasm/sim-core/abi.generated.ts';`,
    sourcefile: 'sim-core-node.ts'
  });
  return loader;
}

/** Instantiate `<wasmDir>/sim_core.wasm` through src/wasm/sim-core/instantiate.ts. */
export async function loadSimCoreFromDisk(wasmDir) {
  const { instantiateSimCore } = await simCoreLoader();
  return instantiateSimCore(readFileSync(join(wasmDir, 'sim_core.wasm')));
}

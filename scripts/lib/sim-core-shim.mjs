/**
 * esbuild plugin for Node harnesses that bundle the app's WASM loader
 * (src/wasm/index.ts).
 *
 * The loader does `import('./sim-core/sim_core.js')` and points the factory at
 * `new URL('./sim-core/sim_core.wasm', import.meta.url)`. Node's fetch cannot
 * read file: URLs, so this resolves the glue import to a shim that calls the
 * real ES-module factory with `wasmBinary` read from disk. Test-only: the
 * production loader has no global or override seam.
 *
 *   plugins: [simCoreShim(WASM_DIR)]
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function simCoreShim(wasmDir) {
  const glue = pathToFileURL(join(wasmDir, 'sim_core.js')).href;
  const wasm = join(wasmDir, 'sim_core.wasm');
  return {
    name: 'sim-core-shim',
    setup(build) {
      // First: the shim's own `import('file:///…/sim-core/sim_core.js')` must stay
      // external, or the rule below resolves the shim to itself (unbounded recursion).
      build.onResolve({ filter: /^(file:|node:)/ }, (args) => ({ path: args.path, external: true }));
      build.onResolve({ filter: /sim-core\/sim_core\.js$/ }, () => ({ path: 'sim-core-shim', namespace: 'sim-core-shim' }));
      build.onLoad({ filter: /.*/, namespace: 'sim-core-shim' }, () => ({
        loader: 'js',
        contents: `
          import { readFileSync } from 'node:fs';
          const wasmBinary = readFileSync(${JSON.stringify(wasm)});
          export default async function SimCore(opts) {
            const { default: real } = await import(${JSON.stringify(glue)});
            return real({ ...opts, wasmBinary });
          }
        `
      }));
    }
  };
}

/**
 * Vite plugin: expand `#include "…"` in `.wgsl` sources (including `?raw`).
 * Uses the same resolver as `wgsl-include.js` so CI and the bundler stay aligned.
 *
 * Important: Vite’s `?raw` path does not always run content through `transform`
 * before stringifying, so we expand in `load` and emit the raw module ourselves
 * when the query contains `raw`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolveWgsl, SHADER_ROOT } from './wgsl-include.js';
import { join, relative } from 'node:path';

function splitId(id) {
  const q = id.indexOf('?');
  if (q < 0) return { path: id, query: '' };
  return { path: id.slice(0, q), query: id.slice(q + 1) };
}

/**
 * @param {{ root?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export function wgslIncludePlugin(options = {}) {
  const root = options.root || SHADER_ROOT;

  return {
    name: 'wgsl-include',
    enforce: 'pre',

    load(id) {
      const { path, query } = splitId(id);
      if (!path.endsWith('.wgsl')) return null;
      if (!existsSync(path)) return null;

      let code;
      try {
        code = readFileSync(path, 'utf8');
      } catch {
        return null;
      }

      if (code.includes('#include')) {
        try {
          code = resolveWgsl(code, { fromFile: path });
        } catch (err) {
          this.error(
            `[wgsl-include] ${relative(root, path)}: ${err.message || err}`
          );
          return null;
        }
      }

      // Handle ?raw (and ?raw&…) so expanded source is what the app imports.
      if (query.split('&').some((p) => p === 'raw' || p.startsWith('raw'))) {
        return `export default ${JSON.stringify(code)}`;
      }

      // Non-raw .wgsl: return expanded source for any downstream consumer.
      return code;
    }
  };
}

/** Default plugin instance for vite.config.js */
export default function wgslInclude() {
  return wgslIncludePlugin({ root: join(SHADER_ROOT) });
}

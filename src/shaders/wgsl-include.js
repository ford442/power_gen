/**
 * Minimal WGSL #include preprocessor.
 *
 * Syntax (line-oriented):
 *   #include "common/particle.wgsl"
 *   #include 'common/frame-uniforms.wgsl'
 *
 * Paths are relative to `src/shaders/` (this package's shader root).
 * Nested includes are expanded; cycles throw. Lines that are only
 * whitespace + a comment after the include are allowed.
 *
 * Browser / Vite: use `resolveWgsl` on string sources, or the Vite plugin
 * that preprocesses `*.wgsl?raw` imports. Node / CI: `loadWgslFile`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `src/shaders/`. */
export const SHADER_ROOT = __dirname;

const INCLUDE_RE = /^\s*#include\s+["']([^"']+)["']\s*(?:\/\/.*)?$/;

/**
 * Resolve a logical include path to an absolute filesystem path.
 * @param {string} includePath e.g. "common/particle.wgsl"
 * @param {string} [fromFile] absolute path of the including file (for relative includes)
 */
export function resolveIncludePath(includePath, fromFile) {
  const cleaned = includePath.replace(/^\.?\//, '');
  // Prefer shader-root-relative paths (canonical style).
  const fromRoot = join(SHADER_ROOT, cleaned);
  if (existsSync(fromRoot)) return normalize(fromRoot);

  if (fromFile) {
    const fromLocal = join(dirname(fromFile), cleaned);
    if (existsSync(fromLocal)) return normalize(fromLocal);
  }

  throw new Error(
    `[wgsl-include] not found: "${includePath}" (root=${SHADER_ROOT})`
  );
}

/**
 * Expand #include directives in a WGSL source string.
 * @param {string} source
 * @param {{ fromFile?: string, stack?: string[] }} [opts]
 * @returns {string}
 */
export function resolveWgsl(source, opts = {}) {
  const stack = opts.stack || [];
  const fromFile = opts.fromFile || null;
  const lines = source.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const m = line.match(INCLUDE_RE);
    if (!m) {
      out.push(line);
      continue;
    }

    const abs = resolveIncludePath(m[1], fromFile || undefined);
    const key = resolve(abs);
    if (stack.includes(key)) {
      throw new Error(
        `[wgsl-include] cycle: ${[...stack, key].map((p) => relative(SHADER_ROOT, p)).join(' → ')}`
      );
    }

    const body = readFileSync(abs, 'utf8');
    const expanded = resolveWgsl(body, {
      fromFile: abs,
      stack: [...stack, key]
    });
    out.push(`// ---- begin include ${m[1]} ----`);
    out.push(expanded);
    out.push(`// ---- end include ${m[1]} ----`);
  }

  return out.join('\n');
}

/**
 * Load a `.wgsl` file under the shader root (or absolute path) and expand includes.
 * @param {string} path relative to shader root or absolute
 */
export function loadWgslFile(path) {
  const abs = isAbsolute(path) ? path : join(SHADER_ROOT, path);
  if (!existsSync(abs)) {
    throw new Error(`[wgsl-include] loadWgslFile missing: ${path}`);
  }
  return resolveWgsl(readFileSync(abs, 'utf8'), { fromFile: abs });
}

/**
 * Tagged template: `wgsl\`#include "common/particle.wgsl"\n...\``
 * Interpolations are stringified before include expansion.
 */
export function wgsl(strings, ...values) {
  let raw = '';
  for (let i = 0; i < strings.length; i++) {
    raw += strings[i];
    if (i < values.length) raw += String(values[i] ?? '');
  }
  return resolveWgsl(raw);
}

/**
 * True if source still has unresolved includes (should not happen after resolveWgsl).
 */
export function hasIncludes(source) {
  return source.split(/\r?\n/).some((line) => INCLUDE_RE.test(line));
}

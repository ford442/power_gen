/**
 * Run fdtd-tmz-compute.wgsl on the CPU — the WGSL leg of test:fdtd's
 * three-way golden (#254 §5).
 *
 * naga can validate the shader but not execute it, and CI has no GPU. This
 * translates the shader's own text (the small WGSL subset it uses: `fn`,
 * `let` / `var`, `for`, `if`, `u`-suffixed literals, `f32()` / `vec2f()`,
 * `min` / `max` / `exp`, uniform and storage bindings) into a JS function and
 * dispatches `updateH` / `updateE` over the grid, exactly as the compute pass
 * does (every invocation independent; bounds checks in the shader itself).
 *
 * f32 semantics, approximately: storage buffers are Float32Arrays, and every
 * `let` / `var` initialiser, compound assignment and `return` is rounded to
 * f32. Intermediate subexpressions run in double, and a real GPU may fuse
 * multiply-adds or use a few-ULP `exp` — so this leg is compared under a
 * tolerance, never bit for bit. What it catches is the shader *as written*
 * drifting from the CPU kernels (a sign, a missing term, a swapped index),
 * which the textual checks in test:fdtd cannot.
 *
 * Test-only. Not imported by the app.
 */

const fround = Math.fround;
const f = (v) => (typeof v === 'number' ? fround(v) : v);

/** `const NAME: u32 = 16u;` lines → { NAME: 16 }. */
function wgslConsts(src) {
  const out = {};
  for (const [, name, value] of src.matchAll(/^const (\w+): \w+ = ([\d.]+)u?;/gm)) out[name] = Number(value);
  return out;
}

/** Translate the compute shader's functions into a JS module body. */
export function translateFdtdWgsl(computeSrc) {
  let s = computeSrc
    .replace(/\/\/.*$/gm, '')
    .replace(/^#include.*$/gm, '')
    .replace(/^@group.*$/gm, '')
    .replace(/@compute\s+@workgroup_size\([^)]*\)/g, '')
    .replace(/@builtin\(\w+\)\s*/g, '');
  // fn name(a: T, b: T) -> R {   →   function name(a, b) {
  s = s.replace(/fn (\w+)\(([^)]*)\)\s*(->\s*[\w<>]+\s*)?\{/g, (_, name, params) => {
    const names = params.split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split(':')[0].trim());
    return `function ${name}(${names.join(', ')}) {`;
  });
  s = s
    // Loop counters first (`for (var k = 0u; …`): mutable, integral, unrounded.
    .replace(/for \(var (\w+) = ([^;]+);/g, 'for (LOOPVAR $1 = $2;')
    .replace(/\blet (\w+) = ([^;]+);/g, 'const $1 = f($2);')
    .replace(/\bvar (\w+) = ([^;]+);/g, 'let $1 = f($2);')
    .replace(/LOOPVAR/g, 'let')
    .replace(/(\b\w+) \+= ([^;]+);/g, '$1 = f($1 + ($2));')
    .replace(/\breturn ([^;]+);/g, 'return f($1);')
    .replace(/\b(\d+)u\b/g, '$1')
    .replace(/\bf32\(/g, 'fround(');
  return s;
}

/**
 * Compile the shader against a grid. Returns `{ step(count) }` that dispatches
 * updateH then updateE over every cell `count` times, on the given buffers.
 */
export function compileFdtdWgsl({ computeSrc, paramsSrc, params, ez, hx, hy, materials }) {
  const consts = wgslConsts(paramsSrc);
  const body = translateFdtdWgsl(computeSrc);
  const constDecls = Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`).join('\n');
  // eslint-disable-next-line no-new-func -- test-only evaluator of trusted repo source
  const factory = new Function('params', 'ez', 'hx', 'hy', 'materials', 'f', 'fround', 'vec2f', 'min', 'max', 'exp',
    `${constDecls}\n${body}\nreturn { updateH, updateE };`);
  const vec2f = (x, y) => ({ x: fround(x), y: fround(y) });
  const exp = (x) => fround(Math.exp(x));
  const { updateH, updateE } = factory(params, ez, hx, hy, materials, f, fround, vec2f, Math.min, Math.max, exp);
  const n = params.n;
  const id = { x: 0, y: 0, z: 0 };
  return {
    step(count = 1) {
      for (let k = 0; k < count; k++) {
        for (const fn of [updateH, updateE]) {
          for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
              id.x = x;
              id.y = y;
              fn(id);
            }
          }
        }
      }
    }
  };
}

/** The `params` uniform object the shader reads (FdtdParams; f32 fields rounded). */
export function fdtdParamsObject(cfg, sources, materialsOn) {
  return {
    n: cfg.n,
    pmlCells: cfg.pmlCells,
    courant: fround(cfg.courant),
    lossMax: fround(cfg.lossMax),
    sourceCount: Math.min(sources.length, 16),
    sourceRadius: fround(cfg.sourceRadius),
    materialFlags: materialsOn ? 1 : 0,
    sources: sources.map((s) => ({ x: fround(s.x), y: fround(s.y), z: fround(s.amp), w: fround(s.polarity ?? Math.sign(s.amp)) }))
  };
}

/** Interleaved (1/μ_r, eLoss) Float32Array → the `array<vec2f>` binding. */
export function materialsBinding(map, cells) {
  const out = new Array(cells);
  for (let i = 0; i < cells; i++) out[i] = { x: map ? map[2 * i] : 1, y: map ? map[2 * i + 1] : 0 };
  return out;
}
